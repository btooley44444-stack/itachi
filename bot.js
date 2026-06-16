const {
  Client, GatewayIntentBits, EmbedBuilder, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType,
} = require('@discordjs/voice');
const play = require('play-dl');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

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
const YTDLP_ARGS = ['--no-playlist', '--extractor-args', 'youtube:player_client=tv,web'];

async function getAudioResource(url) {
  const ytdlpProc = spawn('yt-dlp', ['-f', 'bestaudio', '-o', '-', '--quiet', ...YTDLP_ARGS, url]);
  const ffmpegProc = spawn('ffmpeg', ['-i', 'pipe:0', '-vn', '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1'], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  ytdlpProc.stdout.pipe(ffmpegProc.stdin);
  ytdlpProc.stderr.on('data', d => console.error('yt-dlp:', d.toString()));
  return createAudioResource(ffmpegProc.stdout, { inputType: StreamType.Raw });
}

async function downloadMp4(url, outputPath) {
  await execAsync(
    `yt-dlp -f "bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 ${YTDLP_ARGS.join(' ')} -o "${outputPath}" "${url}"`
  );
}

async function downloadMp3(url, outputPath) {
  await execAsync(
    `yt-dlp -f "bestaudio/best" -x --audio-format mp3 --audio-quality 192K ${YTDLP_ARGS.join(' ')} -o "${outputPath}" "${url}"`
  );
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
    const info = await play.video_info(query);
    const v = info.video_details;
    return { title: v.title, url: v.url, duration: v.durationInSec, author: v.channel?.name, thumbnail: v.thumbnails?.[v.thumbnails.length - 1]?.url };
  }
  const r = (await play.search(query, { limit: 1 }))[0];
  if (!r) throw new Error('No results found.');
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
    const results = await play.search(args.join(' '), { limit: 10 });
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
    const info = await play.video_info(url);
    const v = info.video_details;
    if (v.durationInSec > 1200) return status.edit('❌ Track is over 20 minutes — too long.');
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
  client.user.setActivity('.help | YouTube', { type: 2 });
});

client.login(process.env.DISCORD_TOKEN);    player.on(AudioPlayerStatus.Idle, async () => {
      state.current = null;
      if (state.queue.length > 0) await startPlaying(state);
      else if (state.textChannel) state.textChannel.send('✅ Queue finished!');
    });

    player.on('error', (err) => {
      console.error('Player error:', err.message);
      state.current = null;
      if (state.queue.length > 0) startPlaying(state);
    });

    guilds.set(guildId, state);
  }
  return guilds.get(guildId);
}

// ── yt-dlp helpers ────────────────────────────────────────────────────────────
async function getAudioResource(url) {
  // Pipe yt-dlp → ffmpeg → discord (no login needed, reliable)
  const ytdlpProc = spawn('yt-dlp', [
    '-f', 'bestaudio',
    '-o', '-',
    '--quiet',
    '--no-playlist',
    '--extractor-args', 'youtube:player_client=tv,web',
    url,
  ]);

  const ffmpegProc = spawn('ffmpeg', [
    '-i', 'pipe:0',
    '-vn',
    '-ar', '48000',
    '-ac', '2',
    '-f', 's16le',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'ignore'] });

  ytdlpProc.stdout.pipe(ffmpegProc.stdin);
  ytdlpProc.stderr.on('data', (d) => console.error('yt-dlp:', d.toString()));

  return createAudioResource(ffmpegProc.stdout, { inputType: StreamType.Raw });
}

async function resolveTrack(query) {
  // Direct YouTube URL — use play-dl for metadata (no rate limiting issues)
  if (query.includes('youtube.com') || query.includes('youtu.be')) {
    const info = await play.video_info(query);
    const v = info.video_details;
    return {
      title: v.title,
      url: v.url,
      duration: v.durationInSec,
      author: v.channel?.name,
      thumbnail: v.thumbnails?.[v.thumbnails.length - 1]?.url,
    };
  }
  // Search query
  const results = await play.search(query, { limit: 1 });
  if (!results.length) throw new Error('No results found.');
  const r = results[0];
  return {
    title: r.title,
    url: r.url,
    duration: r.durationInSec,
    author: r.channel?.name,
    thumbnail: r.thumbnails?.[0]?.url,
  };
}

// ── Playback ──────────────────────────────────────────────────────────────────
async function startPlaying(state) {
  if (!state.queue.length || !state.connection) return;
  const track = state.queue.shift();
  state.current = track;
  try {
    const resource = await getAudioResource(track.url);
    state.player.play(resource);
    if (state.textChannel) state.textChannel.send({ embeds: [nowPlayingEmbed(track)] });
  } catch (err) {
    console.error('Stream error:', err.message);
    if (state.textChannel) state.textChannel.send(`❌ Couldn't play **${track.title}**, skipping...`);
    if (state.queue.length > 0) await startPlaying(state);
  }
}

async function ensureVoice(message, state) {
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) { await message.reply('❌ Join a voice channel first!'); return false; }
  state.textChannel = message.channel;
  const connected = state.connection && state.connection.state.status !== VoiceConnectionStatus.Destroyed;
  if (!connected) {
    state.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
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

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDuration(sec) {
  if (!sec) return 'Live';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}

function nowPlayingEmbed(track) {
  const embed = new EmbedBuilder().setTitle('🎵 Now Playing').setDescription(`[${track.title}](${track.url})`).setColor(0xff0000);
  if (track.duration) embed.addFields({ name: 'Duration', value: fmtDuration(track.duration), inline: true });
  if (track.author) embed.addFields({ name: 'Channel', value: track.author, inline: true });
  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  return embed;
}

function sanitize(name) { return name.replace(/[/\\?%*:|"<>]/g, '-').trim(); }

// ── Commands ──────────────────────────────────────────────────────────────────
const commands = {};

commands.play = async (message, args) => {
  if (!args.length) return message.reply('❌ Provide a URL or search term.');
  const state = getGuild(message.guild.id);
  if (!await ensureVoice(message, state)) return;
  const status = await message.reply('🔍 Searching...');
  try {
    const track = await resolveTrack(args.join(' '));
    state.queue.push(track);
    if (state.player.state.status === AudioPlayerStatus.Idle) {
      await status.delete().catch(() => {});
      await startPlaying(state);
    } else {
      const embed = new EmbedBuilder().setTitle('➕ Added to Queue').setDescription(`[${track.title}](${track.url})`).setColor(0x00bfff)
        .addFields({ name: 'Position', value: `#${state.queue.length}`, inline: true }, { name: 'Duration', value: fmtDuration(track.duration), inline: true });
      if (track.thumbnail) embed.setThumbnail(track.thumbnail);
      await status.edit({ content: '', embeds: [embed] });
    }
  } catch (err) { await status.edit(`❌ Error: \`${err.message}\``); }
};

commands.search = async (message, args) => {
  if (!args.length) return message.reply('❌ Provide a search query.');
  const status = await message.reply('🔍 Searching YouTube...');
  try {
    const results = await play.search(args.join(' '), { limit: 5 });
    if (!results.length) return status.edit('❌ No results found.');
    const embed = new EmbedBuilder().setTitle(`🔍 Results for: ${args.join(' ')}`).setColor(0xff0000).setFooter({ text: 'Use !play <title or URL> to queue a result' });
    results.forEach((r, i) => embed.addFields({ name: `${i+1}. ${r.title}`, value: `[Watch](${r.url}) | \`${fmtDuration(r.durationInSec)}\``, inline: false }));
    await status.edit({ content: '', embeds: [embed] });
  } catch (err) { await status.edit(`❌ Search failed: \`${err.message}\``); }
};

commands.download = async (message, args) => {
  if (!args.length) return message.reply('❌ Provide a URL or search term.');
  const status = await message.reply('⏳ Fetching video info...');
  const tmpDir = path.join('/tmp', `dl_${message.id}`);
  try {
    const track = await resolveTrack(args.join(' '));
    if (track.duration > 600) return status.edit('❌ Video is over 10 minutes. Use `!play` to stream it instead.');
    await status.edit(`⏬ Downloading **${track.title}**...`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `${sanitize(track.title)}.mp4`);
    await execAsync(`yt-dlp -f "bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 -o "${outputPath}" --no-playlist --extractor-args "youtube:player_client=tv,web" "${track.url}"`);
    const sizeMB = fs.statSync(outputPath).size / (1024 * 1024);
    if (sizeMB > 25) return status.edit(`❌ File is ${sizeMB.toFixed(1)} MB — too large. Try \`!play\` to stream it.`);
    await status.edit(`✅ Sending **${track.title}** (${sizeMB.toFixed(1)} MB)...`);
    await message.channel.send({ files: [{ attachment: outputPath, name: `${sanitize(track.title)}.mp4` }] });
    await status.delete().catch(() => {});
  } catch (err) { await status.edit(`❌ Error: \`${err.message}\``); }
  finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
};

commands.audio = async (message, args) => {
  if (!args.length) return message.reply('❌ Provide a URL or search term.');
  const status = await message.reply('⏳ Fetching audio info...');
  const tmpDir = path.join('/tmp', `audio_${message.id}`);
  try {
    const track = await resolveTrack(args.join(' '));
    if (track.duration > 1200) return status.edit('❌ Track is over 20 minutes — too long.');
    await status.edit(`⏬ Downloading audio for **${track.title}**...`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `${sanitize(track.title)}.mp3`);
    await execAsync(`yt-dlp -f "bestaudio/best" -x --audio-format mp3 --audio-quality 192K -o "${outputPath}" --no-playlist --extractor-args "youtube:player_client=tv,web" "${track.url}"`);
    const sizeMB = fs.statSync(outputPath).size / (1024 * 1024);
    if (sizeMB > 25) return status.edit(`❌ File is ${sizeMB.toFixed(1)} MB — too large.`);
    await status.edit(`✅ Sending **${track.title}** (${sizeMB.toFixed(1)} MB)...`);
    await message.channel.send({ files: [{ attachment: outputPath, name: `${sanitize(track.title)}.mp3` }] });
    await status.delete().catch(() => {});
  } catch (err) { await status.edit(`❌ Error: \`${err.message}\``); }
  finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
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
  state.queue.slice(0, 9).forEach((t, i) => embed.addFields({ name: `${i+1}. ${t.title}`, value: `[Link](${t.url}) | \`${fmtDuration(t.duration)}\``, inline: false }));
  if (state.queue.length > 9) embed.setFooter({ text: `…and ${state.queue.length - 9} more` });
  await message.reply({ embeds: [embed] });
};

commands.nowplaying = async (message) => {
  const state = getGuild(message.guild.id);
  if (!state.current) return message.reply('❌ Nothing is playing.');
  await message.reply({ embeds: [nowPlayingEmbed(state.current)] });
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
  const embed = new EmbedBuilder().setTitle('📖 Commands').setColor(0xff0000)
    .addFields(
      { name: '🎵 Playback', value: '`!play` `!search` `!skip` `!pause` `!resume` `!stop` `!nowplaying` `!queue` `!leave`', inline: false },
      { name: '📥 Downloads', value: '`!download` — MP4 video\n`!audio` — MP3 audio', inline: false }
    ).setFooter({ text: 'Aliases: !p !s !dl !mp3 !np !q !dc' });
  await message.reply({ embeds: [embed] });
};

const aliases = { p:'play', s:'search', dl:'download', save:'download', mp3:'audio', np:'nowplaying', q:'queue', dc:'leave', disconnect:'leave', next:'skip', sk:'skip' };

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;
  const [rawCmd, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = aliases[rawCmd.toLowerCase()] ?? rawCmd.toLowerCase();
  if (!commands[cmd]) return;
  try { await commands[cmd](message, args); }
  catch (err) { console.error(`[${cmd}] error:`, err); message.reply(`❌ Unexpected error: \`${err.message}\``).catch(() => {}); }
});

client.once(Events.ClientReady, () => {
  console.log(`✅ Online as ${client.user.tag}`);
  client.user.setActivity('!help | YouTube', { type: 2 });
});

client.login(process.env.DISCORD_TOKEN);

  const ffmpegProc = spawn('ffmpeg', [
    '-i', 'pipe:0',
    '-vn',
    '-ar', '48000',
    '-ac', '2',
    '-f', 's16le',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'ignore'] });

  ytdlpProc.stdout.pipe(ffmpegProc.stdin);
  ytdlpProc.stderr.on('data', (d) => console.error('yt-dlp:', d.toString()));

  return createAudioResource(ffmpegProc.stdout, { inputType: StreamType.Raw });
}

async function resolveTrack(query) {
  // Direct YouTube URL
  if (query.includes('youtube.com') || query.includes('youtu.be')) {
    const { stdout } = await execAsync(
      `yt-dlp --dump-single-json --no-playlist "${query}"`
    );
    const info = JSON.parse(stdout);
    return {
      title: info.title,
      url: `https://www.youtube.com/watch?v=${info.id}`,
      duration: info.duration,
      author: info.uploader,
      thumbnail: info.thumbnail,
    };
  }
  // Search query — use play-dl (fast, no auth needed for search)
  const results = await play.search(query, { limit: 1 });
  if (!results.length) throw new Error('No results found.');
  const r = results[0];
  return {
    title: r.title,
    url: r.url,
    duration: r.durationInSec,
    author: r.channel?.name,
    thumbnail: r.thumbnails?.[0]?.url,
  };
}

// ── Playback ──────────────────────────────────────────────────────────────────
async function startPlaying(state) {
  if (!state.queue.length || !state.connection) return;
  const track = state.queue.shift();
  state.current = track;
  try {
    const resource = await getAudioResource(track.url);
    state.player.play(resource);
    if (state.textChannel) state.textChannel.send({ embeds: [nowPlayingEmbed(track)] });
  } catch (err) {
    console.error('Stream error:', err.message);
    if (state.textChannel) state.textChannel.send(`❌ Couldn't play **${track.title}**, skipping...`);
    if (state.queue.length > 0) await startPlaying(state);
  }
}

async function ensureVoice(message, state) {
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) { await message.reply('❌ Join a voice channel first!'); return false; }
  state.textChannel = message.channel;
  const connected = state.connection && state.connection.state.status !== VoiceConnectionStatus.Destroyed;
  if (!connected) {
    state.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
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

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDuration(sec) {
  if (!sec) return 'Live';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}

function nowPlayingEmbed(track) {
  const embed = new EmbedBuilder().setTitle('🎵 Now Playing').setDescription(`[${track.title}](${track.url})`).setColor(0xff0000);
  if (track.duration) embed.addFields({ name: 'Duration', value: fmtDuration(track.duration), inline: true });
  if (track.author) embed.addFields({ name: 'Channel', value: track.author, inline: true });
  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  return embed;
}

function sanitize(name) { return name.replace(/[/\\?%*:|"<>]/g, '-').trim(); }

// ── Commands ──────────────────────────────────────────────────────────────────
const commands = {};

commands.play = async (message, args) => {
  if (!args.length) return message.reply('❌ Provide a URL or search term.');
  const state = getGuild(message.guild.id);
  if (!await ensureVoice(message, state)) return;
  const status = await message.reply('🔍 Searching...');
  try {
    const track = await resolveTrack(args.join(' '));
    state.queue.push(track);
    if (state.player.state.status === AudioPlayerStatus.Idle) {
      await status.delete().catch(() => {});
      await startPlaying(state);
    } else {
      const embed = new EmbedBuilder().setTitle('➕ Added to Queue').setDescription(`[${track.title}](${track.url})`).setColor(0x00bfff)
        .addFields({ name: 'Position', value: `#${state.queue.length}`, inline: true }, { name: 'Duration', value: fmtDuration(track.duration), inline: true });
      if (track.thumbnail) embed.setThumbnail(track.thumbnail);
      await status.edit({ content: '', embeds: [embed] });
    }
  } catch (err) { await status.edit(`❌ Error: \`${err.message}\``); }
};

commands.search = async (message, args) => {
  if (!args.length) return message.reply('❌ Provide a search query.');
  const status = await message.reply('🔍 Searching YouTube...');
  try {
    const results = await play.search(args.join(' '), { limit: 5 });
    if (!results.length) return status.edit('❌ No results found.');
    const embed = new EmbedBuilder().setTitle(`🔍 Results for: ${args.join(' ')}`).setColor(0xff0000).setFooter({ text: 'Use !play <title or URL> to queue a result' });
    results.forEach((r, i) => embed.addFields({ name: `${i+1}. ${r.title}`, value: `[Watch](${r.url}) | \`${fmtDuration(r.durationInSec)}\``, inline: false }));
    await status.edit({ content: '', embeds: [embed] });
  } catch (err) { await status.edit(`❌ Search failed: \`${err.message}\``); }
};

commands.download = async (message, args) => {
  if (!args.length) return message.reply('❌ Provide a URL or search term.');
  const status = await message.reply('⏳ Fetching video info...');
  const tmpDir = path.join('/tmp', `dl_${message.id}`);
  try {
    const track = await resolveTrack(args.join(' '));
    if (track.duration > 600) return status.edit('❌ Video is over 10 minutes. Use `!play` to stream it instead.');
    await status.edit(`⏬ Downloading **${track.title}**...`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `${sanitize(track.title)}.mp4`);
    await execAsync(`yt-dlp -f "bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 -o "${outputPath}" --no-playlist "${track.url}"`);
    const sizeMB = fs.statSync(outputPath).size / (1024 * 1024);
    if (sizeMB > 25) return status.edit(`❌ File is ${sizeMB.toFixed(1)} MB — too large. Try \`!play\` to stream it.`);
    await status.edit(`✅ Sending **${track.title}** (${sizeMB.toFixed(1)} MB)...`);
    await message.channel.send({ files: [{ attachment: outputPath, name: `${sanitize(track.title)}.mp4` }] });
    await status.delete().catch(() => {});
  } catch (err) { await status.edit(`❌ Error: \`${err.message}\``); }
  finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
};

commands.audio = async (message, args) => {
  if (!args.length) return message.reply('❌ Provide a URL or search term.');
  const status = await message.reply('⏳ Fetching audio info...');
  const tmpDir = path.join('/tmp', `audio_${message.id}`);
  try {
    const track = await resolveTrack(args.join(' '));
    if (track.duration > 1200) return status.edit('❌ Track is over 20 minutes — too long.');
    await status.edit(`⏬ Downloading audio for **${track.title}**...`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `${sanitize(track.title)}.mp3`);
    await execAsync(`yt-dlp -f "bestaudio/best" -x --audio-format mp3 --audio-quality 192K -o "${outputPath}" --no-playlist "${track.url}"`);
    const sizeMB = fs.statSync(outputPath).size / (1024 * 1024);
    if (sizeMB > 25) return status.edit(`❌ File is ${sizeMB.toFixed(1)} MB — too large.`);
    await status.edit(`✅ Sending **${track.title}** (${sizeMB.toFixed(1)} MB)...`);
    await message.channel.send({ files: [{ attachment: outputPath, name: `${sanitize(track.title)}.mp3` }] });
    await status.delete().catch(() => {});
  } catch (err) { await status.edit(`❌ Error: \`${err.message}\``); }
  finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
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
  state.queue.slice(0, 9).forEach((t, i) => embed.addFields({ name: `${i+1}. ${t.title}`, value: `[Link](${t.url}) | \`${fmtDuration(t.duration)}\``, inline: false }));
  if (state.queue.length > 9) embed.setFooter({ text: `…and ${state.queue.length - 9} more` });
  await message.reply({ embeds: [embed] });
};

commands.nowplaying = async (message) => {
  const state = getGuild(message.guild.id);
  if (!state.current) return message.reply('❌ Nothing is playing.');
  await message.reply({ embeds: [nowPlayingEmbed(state.current)] });
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
  const embed = new EmbedBuilder().setTitle('📖 Commands').setColor(0xff0000)
    .addFields(
      { name: '🎵 Playback', value: '`!play` `!search` `!skip` `!pause` `!resume` `!stop` `!nowplaying` `!queue` `!leave`', inline: false },
      { name: '📥 Downloads', value: '`!download` — MP4 video\n`!audio` — MP3 audio', inline: false }
    ).setFooter({ text: 'Aliases: !p !s !dl !mp3 !np !q !dc' });
  await message.reply({ embeds: [embed] });
};

const aliases = { p:'play', s:'search', dl:'download', save:'download', mp3:'audio', np:'nowplaying', q:'queue', dc:'leave', disconnect:'leave', next:'skip', sk:'skip' };

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;
  const [rawCmd, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = aliases[rawCmd.toLowerCase()] ?? rawCmd.toLowerCase();
  if (!commands[cmd]) return;
  try { await commands[cmd](message, args); }
  catch (err) { console.error(`[${cmd}] error:`, err); message.reply(`❌ Unexpected error: \`${err.message}\``).catch(() => {}); }
});

client.once(Events.ClientReady, () => {
  console.log(`✅ Online as ${client.user.tag}`);
  client.user.setActivity('!help | YouTube', { type: 2 });
});

client.login(process.env.DISCORD_TOKEN);
