const {
  Client, GatewayIntentBits, EmbedBuilder, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType,
} = require('@discordjs/voice');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const execAsync = promisify(exec);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const PREFIX = '.';
const guilds = new Map();
const searchSessions = new Map(); // userId → { results, index }

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDuration(sec) {
  if (!sec) return 'Live';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtViews(n) {
  if (!n) return 'Unknown';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function sanitize(name) {
  return name.replace(/[/\\?%*:|"<>]/g, '-').trim();
}

function searchEmbed(results, index) {
  const r = results[index];
  return new EmbedBuilder()
    .setTitle(r.title)
    .setURL(r.url)
    .setColor(0xff0000)
    .setThumbnail(r.thumbnails?.[r.thumbnails.length - 1]?.url ?? null)
    .addFields(
      { name: 'Channel',  value: r.channel?.name ?? 'Unknown', inline: true },
      { name: 'Duration', value: fmtDuration(r.durationInSec),  inline: true },
      { name: 'Views',    value: fmtViews(r.views),              inline: true },
    )
    .setFooter({ text: `Result ${index + 1} of ${results.length} • .dl to download • .play to stream` });
}

function searchButtons(index, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('prev')    .setLabel('◀ Prev')      .setStyle(ButtonStyle.Secondary).setDisabled(index === 0),
    new ButtonBuilder().setCustomId('next')    .setLabel('Next ▶')      .setStyle(ButtonStyle.Secondary).setDisabled(index === total - 1),
    new ButtonBuilder().setCustomId('download').setLabel('⬇ Download')  .setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('playBtn') .setLabel('▶ Play')      .setStyle(ButtonStyle.Primary),
  );
}

// ── yt-dlp helpers ────────────────────────────────────────────────────────────
// Place a cookies.txt file (exported from your browser while logged into YouTube)
// in the same folder as this bot file to fix YouTube bot-detection errors.
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');
const COOKIES_EXIST = fs.existsSync(COOKIES_PATH);
const COOKIES_ARG = COOKIES_EXIST ? ['--cookies', COOKIES_PATH] : [];

// Used for downloads/streaming — includes rate-limit delay
const YTDLP_ARGS = [
  '--no-playlist',
  '--extractor-args', 'youtube:player_client=android',
  '--sleep-requests', '1',
  ...COOKIES_ARG,
];

// Used for metadata (search, info) — no delay needed
const YTDLP_META_ARGS = [
  '--no-playlist',
  '--extractor-args', 'youtube:player_client=android',
  ...COOKIES_ARG,
];

// Run yt-dlp and return stdout as a string
function ytdlpRun(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args);
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => code === 0 ? resolve(out) : reject(new Error(err.trim() || `yt-dlp exited ${code}`)));
  });
}

// Search YouTube — returns array of result objects shaped like play-dl results
async function ytSearch(query, limit = 10) {
  const out = await ytdlpRun([
    `ytsearch${limit}:${query}`,
    '--dump-json', '--flat-playlist', '--quiet', '--no-warnings',
    ...YTDLP_META_ARGS,
  ]);
  return out.trim().split('\n').filter(Boolean).map(line => {
    const v = JSON.parse(line);
    return {
      title:       v.title ?? 'Unknown',
      url:         v.url?.startsWith('http') ? v.url : `https://www.youtube.com/watch?v=${v.id}`,
      durationInSec: v.duration ?? 0,
      views:       v.view_count ?? 0,
      channel:     { name: v.channel || v.uploader || 'Unknown' },
      thumbnails:  [{ url: v.thumbnail || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg` }],
    };
  });
}

// Fetch metadata for a single video URL
async function ytInfo(url) {
  const out = await ytdlpRun([
    url, '--dump-json', '--quiet', '--no-warnings', ...YTDLP_META_ARGS,
  ]);
  const v = JSON.parse(out.trim());
  return {
    title:     v.title ?? 'Unknown',
    url:       `https://www.youtube.com/watch?v=${v.id}`,
    duration:  v.duration ?? 0,   // track objects use 'duration'
    author:    v.channel || v.uploader || 'Unknown',
    thumbnail: v.thumbnail || null,
  };
}

async function getAudioResource(url) {
  const ytdlpProc = spawn('yt-dlp', ['-f', 'bestaudio', '-o', '-', '--quiet', ...YTDLP_ARGS, url]);
  const ffmpegProc = spawn('ffmpeg', ['-i', 'pipe:0', '-vn', '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1'], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  ytdlpProc.stdout.pipe(ffmpegProc.stdin);
  ytdlpProc.stderr.on('data', d => console.error('yt-dlp:', d.toString()));
  return createAudioResource(ffmpegProc.stdout, { inputType: StreamType.Raw });
}

// ── phptools.org downloader ───────────────────────────────────────────────────
function streamToFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(dest, () => {});
        return streamToFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

async function phptoolsGetUrl(videoUrl) {
  const body = Buffer.from(`yt_url=${encodeURIComponent(videoUrl)}`);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.phptools.org',
      path: '/youtube/index.php',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': body.length,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.phptools.org/youtube/index.php',
        'Origin': 'https://www.phptools.org',
      },
    }, res => {
      let out = '';
      res.on('data', d => out += d);
      res.on('end', () => {
        try {
          const data = JSON.parse(out);
          if (!data.ok || !data.public_url) reject(new Error(data.error || 'No download URL returned'));
          else resolve(data.public_url);
        } catch { reject(new Error('Unexpected response from downloader')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function downloadMp4(url, outputPath) {
  const publicUrl = await phptoolsGetUrl(url);
  await streamToFile(publicUrl, outputPath);
}

async function downloadMp3(url, outputPath) {
  const tmpPath = outputPath.replace(/\.mp3$/, '_tmp.mp4');
  try {
    const publicUrl = await phptoolsGetUrl(url);
    await streamToFile(publicUrl, tmpPath);
    await execAsync(`ffmpeg -i "${tmpPath}" -vn -ar 44100 -ac 2 -b:a 192k "${outputPath}" -y`);
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

// ── Guild state ───────────────────────────────────────────────────────────────
function getGuild(guildId) {
  if (!guilds.has(guildId)) {
    const player = createAudioPlayer();
    const state = { queue: [], player, connection: null, current: null, textChannel: null };

    player.on(AudioPlayerStatus.Idle, async () => {
      state.current = null;
      if (state.queue.length > 0) await startPlaying(state);
      else if (state.textChannel) state.textChannel.send('✅ Queue finished!');
    });

    player.on('error', err => {
      console.error('Player error:', err.message);
      state.current = null;
      if (state.queue.length > 0) startPlaying(state);
    });

    guilds.set(guildId, state);
  }
  return guilds.get(guildId);
}

async function startPlaying(state) {
  if (!state.queue.length || !state.connection) return;
  const track = state.queue.shift();
  state.current = track;
  try {
    const resource = await getAudioResource(track.url);
    state.player.play(resource);
    if (state.textChannel) {
      state.textChannel.send({ embeds: [
        new EmbedBuilder()
          .setTitle('🎵 Now Playing')
          .setDescription(`[${track.title}](${track.url})`)
          .setColor(0xff0000)
          .addFields(
            { name: 'Duration', value: fmtDuration(track.duration), inline: true },
            { name: 'Channel',  value: track.author ?? 'Unknown',    inline: true },
          )
          .setThumbnail(track.thumbnail ?? null),
      ]});
    }
  } catch (err) {
    console.error('Stream error:', err.message);
    if (state.textChannel) state.textChannel.send(`❌ Couldn't play **${track.title}**, skipping...`);
    if (state.queue.length > 0) await startPlaying(state);
  }
}

async function ensureVoice(message, state) {
  const vc = message.member?.voice?.channel;
  if (!vc) { await message.reply('❌ Join a voice channel first!'); return false; }
  state.textChannel = message.channel;
  if (!state.connection || state.connection.state.status === VoiceConnectionStatus.Destroyed) {
    state.connection = joinVoiceChannel({
      channelId: vc.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
    });
    state.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(state.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(state.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch { state.connection.destroy(); state.connection = null; }
    });
    state.connection.subscribe(state.player);
  }
  return true;
}

// ── Resolve a track from URL or search query ──────────────────────────────────
async function resolveTrack(query) {
  if (query.includes('youtube.com') || query.includes('youtu.be')) {
    return ytInfo(query);
  }
  const results = await ytSearch(query, 1);
  if (!results.length) throw new Error('No results found.');
  const r = results[0];
  return { title: r.title, url: r.url, duration: r.durationInSec, author: r.channel?.name, thumbnail: r.thumbnails?.[0]?.url };
}

// ── Download helper (shared by .dl command and ⬇ button) ─────────────────────
async function handleDownload(track, replyFn, sendFileFn) {
  if (track.duration > 600) {
    await replyFn('❌ Video is over 10 minutes. Use `.play` to stream it instead.');
    return;
  }
  const tmpDir = path.join('/tmp', `dl_${Date.now()}`);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `${sanitize(track.title)}.mp4`);
    await replyFn(`⏬ Downloading **${track.title}**...`);
    await downloadMp4(track.url, outputPath);
    const sizeMB = fs.statSync(outputPath).size / (1024 * 1024);
    if (sizeMB > 25) {
      await replyFn(`❌ File is ${sizeMB.toFixed(1)} MB — too large for Discord. Try \`.play\` to stream it.`);
      return;
    }
    await replyFn(`✅ Sending **${track.title}** (${sizeMB.toFixed(1)} MB)...`);
    await sendFileFn(outputPath, `${sanitize(track.title)}.mp4`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────
const commands = {};

// .yt — browse search results
commands.yt = async (message, args) => {
  if (!args.length) return message.reply('❌ Provide a search query. e.g. `.yt never gonna give you up`');
  const status = await message.reply('🔍 Searching YouTube...');
  try {
    const results = await ytSearch(args.join(' '), 10);
    if (!results.length) return status.edit('❌ No results found.');
    searchSessions.set(message.author.id, { results, index: 0 });
    await status.edit({ content: '', embeds: [searchEmbed(results, 0)], components: [searchButtons(0, results.length)] });
  } catch (err) {
    await status.edit(`❌ Search failed: \`${err.message}\``);
  }
};

// .dl — download current search result (or a direct URL/query)
commands.dl = async (message, args) => {
  let track;

  if (args.length) {
    const status = await message.reply('⏳ Fetching info...');
    try {
      track = await resolveTrack(args.join(' '));
      let statusText = '';
      await handleDownload(
        track,
        text => { statusText = text; return status.edit(text); },
        (filePath, name) => message.channel.send({ files: [{ attachment: filePath, name }] }),
      );
      if (statusText.startsWith('✅')) await status.delete().catch(() => {});
    } catch (err) {
      await status.edit(`❌ Error: \`${err.message}\``);
    }
    return;
  }

  const session = searchSessions.get(message.author.id);
  if (!session) return message.reply('❌ No active search. Use `.yt <query>` first, then browse with the buttons.');
  const r = session.results[session.index];
  track = { title: r.title, url: r.url, duration: r.durationInSec, author: r.channel?.name };

  const status = await message.reply(`⏳ Starting download...`);
  try {
    let statusText = '';
    await handleDownload(
      track,
      text => { statusText = text; return status.edit(text); },
      (filePath, name) => message.channel.send({ files: [{ attachment: filePath, name }] }),
    );
    if (statusText.startsWith('✅')) await status.delete().catch(() => {});
  } catch (err) {
    await status.edit(`❌ Error: \`${err.message}\``);
  }
};

// .mp3 — download as audio
commands.mp3 = async (message, args) => {
  let url;

  if (args.length) {
    try { url = (await resolveTrack(args.join(' '))).url; }
    catch (err) { return message.reply(`❌ ${err.message}`); }
  } else {
    const session = searchSessions.get(message.author.id);
    if (!session) return message.reply('❌ Provide a URL/query or use `.yt` first.');
    url = session.results[session.index].url;
  }

  const status = await message.reply('⏳ Fetching info...');
  const tmpDir = path.join('/tmp', `mp3_${Date.now()}`);
  try {
    const v = await ytInfo(url);
    if (v.duration > 1200) return status.edit('❌ Track is over 20 minutes — too long.');
    fs.mkdirSync(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `${sanitize(v.title)}.mp3`);
    await status.edit(`⏬ Downloading audio for **${v.title}**...`);
    await downloadMp3(url, outputPath);
    const sizeMB = fs.statSync(outputPath).size / (1024 * 1024);
    if (sizeMB > 25) return status.edit(`❌ File is ${sizeMB.toFixed(1)} MB — too large.`);
    await status.edit(`✅ Sending **${v.title}** (${sizeMB.toFixed(1)} MB)...`);
    await message.channel.send({ files: [{ attachment: outputPath, name: `${sanitize(v.title)}.mp3` }] });
    await status.delete().catch(() => {});
  } catch (err) {
    await status.edit(`❌ Error: \`${err.message}\``);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
};

// .play — stream to voice
commands.play = async (message, args) => {
  const state = getGuild(message.guild.id);
  if (!await ensureVoice(message, state)) return;

  let track;
  if (!args.length) {
    const session = searchSessions.get(message.author.id);
    if (!session) return message.reply('❌ Provide a URL/query or use `.yt` to search first.');
    const r = session.results[session.index];
    track = { title: r.title, url: r.url, duration: r.durationInSec, author: r.channel?.name, thumbnail: r.thumbnails?.[r.thumbnails.length - 1]?.url };
  } else {
    const status = await message.reply('🔍 Searching...');
    try {
      track = await resolveTrack(args.join(' '));
      await status.delete().catch(() => {});
    } catch (err) {
      return status.edit(`❌ ${err.message}`);
    }
  }

  state.queue.push(track);
  if (state.player.state.status === AudioPlayerStatus.Idle) {
    await startPlaying(state);
  } else {
    await message.reply({ embeds: [
      new EmbedBuilder()
        .setTitle('➕ Added to Queue')
        .setDescription(`[${track.title}](${track.url})`)
        .setColor(0x00bfff)
        .addFields(
          { name: 'Position', value: `#${state.queue.length}`, inline: true },
          { name: 'Duration', value: fmtDuration(track.duration),  inline: true },
        )
        .setThumbnail(track.thumbnail ?? null),
    ]});
  }
};

commands.skip = async (message) => {
  const state = getGuild(message.guild.id);
  if (state.player.state.status === AudioPlayerStatus.Idle) return message.reply('❌ Nothing is playing.');
  state.player.stop();
  await message.reply('⏭️ Skipped!');
};

commands.queue = async (message) => {
  const state = getGuild(message.guild.id);
  if (!state.current && !state.queue.length) return message.reply('📭 The queue is empty.');
  const embed = new EmbedBuilder().setTitle('🎵 Queue').setColor(0xff0000);
  if (state.current) embed.addFields({ name: '▶️ Now Playing', value: `[${state.current.title}](${state.current.url}) | \`${fmtDuration(state.current.duration)}\``, inline: false });
  state.queue.slice(0, 9).forEach((t, i) => embed.addFields({ name: `${i + 1}. ${t.title}`, value: `[Link](${t.url}) | \`${fmtDuration(t.duration)}\``, inline: false }));
  if (state.queue.length > 9) embed.setFooter({ text: `…and ${state.queue.length - 9} more` });
  await message.reply({ embeds: [embed] });
};

commands.np = async (message) => {
  const state = getGuild(message.guild.id);
  if (!state.current) return message.reply('❌ Nothing is playing.');
  await message.reply({ embeds: [
    new EmbedBuilder()
      .setTitle('🎵 Now Playing')
      .setDescription(`[${state.current.title}](${state.current.url})`)
      .setColor(0xff0000)
      .addFields({ name: 'Duration', value: fmtDuration(state.current.duration), inline: true })
      .setThumbnail(state.current.thumbnail ?? null),
  ]});
};

commands.pause = async (message) => {
  const state = getGuild(message.guild.id);
  if (state.player.state.status !== AudioPlayerStatus.Playing) return message.reply('❌ Nothing is playing.');
  state.player.pause();
  await message.reply('⏸️ Paused.');
};

commands.resume = async (message) => {
  const state = getGuild(message.guild.id);
  if (state.player.state.status !== AudioPlayerStatus.Paused) return message.reply('❌ Nothing is paused.');
  state.player.unpause();
  await message.reply('▶️ Resumed.');
};

commands.stop = async (message) => {
  const state = getGuild(message.guild.id);
  state.queue = []; state.player.stop(true); state.current = null;
  await message.reply('⏹️ Stopped and queue cleared.');
};

commands.leave = async (message) => {
  const state = getGuild(message.guild.id);
  if (!state.connection) return message.reply('❌ Not in a voice channel.');
  state.queue = []; state.player.stop(true); state.current = null;
  state.connection.destroy(); state.connection = null;
  await message.reply('👋 Disconnected.');
};

commands.help = async (message) => {
  await message.reply({ embeds: [
    new EmbedBuilder()
      .setTitle('📖 Commands')
      .setColor(0xff0000)
      .addFields(
        { name: '🔍 Search & Download', value: '`.yt <query>` — browse results with ◀ ▶ buttons\n`.dl` — download current result as MP4\n`.dl <url or query>` — download directly\n`.mp3 [url or query]` — download as MP3', inline: false },
        { name: '🎵 Music', value: '`.play [url or query]` — stream to voice (no args = use current `.yt` result)\n`.skip` `.pause` `.resume` `.stop` `.np` `.queue` `.leave`', inline: false },
      )
      .setFooter({ text: 'Prefix: .' }),
  ]});
};

const aliases = {
  p: 'play', q: 'queue', dc: 'leave', disconnect: 'leave',
  next: 'skip', sk: 'skip', download: 'dl', audio: 'mp3', nowplaying: 'np',
};

// ── Button interaction handler ────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  const session = searchSessions.get(interaction.user.id);
  if (!session) {
    return interaction.reply({ content: '❌ Your search session expired. Run `.yt` again.', ephemeral: true });
  }

  const { results } = session;

  if (interaction.customId === 'prev') {
    if (session.index > 0) session.index--;
    return interaction.update({ embeds: [searchEmbed(results, session.index)], components: [searchButtons(session.index, results.length)] });
  }

  if (interaction.customId === 'next') {
    if (session.index < results.length - 1) session.index++;
    return interaction.update({ embeds: [searchEmbed(results, session.index)], components: [searchButtons(session.index, results.length)] });
  }

  if (interaction.customId === 'download') {
    await interaction.deferReply();
    const r = results[session.index];
    const track = { title: r.title, url: r.url, duration: r.durationInSec };
    try {
      await handleDownload(
        track,
        text => interaction.editReply(text),
        (filePath, name) => interaction.channel.send({ files: [{ attachment: filePath, name }] }),
      );
      await interaction.deleteReply().catch(() => {});
    } catch (err) {
      await interaction.editReply(`❌ Error: \`${err.message}\``);
    }
    return;
  }

  if (interaction.customId === 'playBtn') {
    const vc = interaction.member?.voice?.channel;
    if (!vc) return interaction.reply({ content: '❌ Join a voice channel first!', ephemeral: true });
    const r = results[session.index];
    const track = { title: r.title, url: r.url, duration: r.durationInSec, author: r.channel?.name, thumbnail: r.thumbnails?.[r.thumbnails.length - 1]?.url };
    const state = getGuild(interaction.guild.id);
    state.textChannel = interaction.channel;
    if (!state.connection || state.connection.state.status === VoiceConnectionStatus.Destroyed) {
      state.connection = joinVoiceChannel({ channelId: vc.id, guildId: interaction.guild.id, adapterCreator: interaction.guild.voiceAdapterCreator });
      state.connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try { await Promise.race([entersState(state.connection, VoiceConnectionStatus.Signalling, 5_000), entersState(state.connection, VoiceConnectionStatus.Connecting, 5_000)]); }
        catch { state.connection.destroy(); state.connection = null; }
      });
      state.connection.subscribe(state.player);
    }
    state.queue.push(track);
    if (state.player.state.status === AudioPlayerStatus.Idle) {
      await interaction.reply({ content: '▶️ Starting...', ephemeral: true });
      await startPlaying(state);
    } else {
      await interaction.reply({ content: `➕ Added **${track.title}** to queue at #${state.queue.length}`, ephemeral: true });
    }
  }
});

// ── Message handler ───────────────────────────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;
  const [rawCmd, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = aliases[rawCmd.toLowerCase()] ?? rawCmd.toLowerCase();
  if (!commands[cmd]) return;
  try { await commands[cmd](message, args); }
  catch (err) {
    console.error(`[${cmd}] error:`, err);
    message.reply(`❌ Unexpected error: \`${err.message}\``).catch(() => {});
  }
});

client.once(Events.ClientReady, () => {
  console.log(`✅ Online as ${client.user.tag}`);
  if (!COOKIES_EXIST) {
    console.warn('⚠️  cookies.txt not found — YouTube downloads may fail with bot-detection errors.');
    console.warn('   Export cookies from your browser at youtube.com and place cookies.txt next to bot.js');
  } else {
    console.log('🍪 cookies.txt loaded');
  }
  client.user.setActivity('bren is cool', { type: 2 });
});

client.login(process.env.DISCORD_TOKEN);
