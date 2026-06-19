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

// ── YouTube InnerTube API (direct, no third-party services) ─────────────────
// This is the same internal API yt-dlp uses, called directly from Node.js.
// Android client context returns pre-signed stream URLs — no cipher decoding needed.

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const ANDROID_CTX = {
  client: {
    clientName: 'ANDROID', clientVersion: '17.31.35',
    androidSdkVersion: 30, hl: 'en', gl: 'US',
    userAgent: 'com.google.android.youtube/17.31.35 (Linux; U; Android 11) gzip',
  },
};

function extractVideoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return m?.[1] ?? null;
}

function innertubePost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: 'www.youtube.com',
      path: '/youtubei/v1/' + endpoint + '?key=' + INNERTUBE_KEY + '&prettyPrint=false',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        'User-Agent': 'com.google.android.youtube/17.31.35 (Linux; U; Android 11) gzip',
        'X-YouTube-Client-Name': '3',
        'X-YouTube-Client-Version': '17.31.35',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 12000,
    }, res => {
      let out = '';
      res.on('data', d => out += d);
      res.on('end', () => {
        try { resolve(JSON.parse(out)); }
        catch { reject(new Error('Bad InnerTube response: ' + out.slice(0, 80))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('InnerTube timed out')); });
    req.write(payload);
    req.end();
  });
}

async function getPlayerData(videoId) {
  const data = await innertubePost('player', { videoId, context: ANDROID_CTX });
  const status = data?.playabilityStatus?.status;
  if (status !== 'OK') throw new Error(data?.playabilityStatus?.reason ?? 'Video unavailable (' + status + ')');
  return data;
}

function parseDurText(t) {
  if (!t) return 0;
  return t.split(':').map(Number).reverse().reduce((s, v, i) => s + v * Math.pow(60, i), 0);
}

function findVideos(obj, found = []) {
  if (!obj || typeof obj !== 'object') return found;
  const v = obj.videoRenderer ?? obj.compactVideoRenderer;
  if (v?.videoId) {
    found.push({
      title:         v.title?.runs?.[0]?.text ?? v.title?.simpleText ?? 'Unknown',
      url:           'https://www.youtube.com/watch?v=' + v.videoId,
      durationInSec: parseDurText(v.lengthText?.simpleText),
      views:         parseInt((v.viewCountText?.simpleText ?? '').replace(/[^0-9]/g, '')) || 0,
      channel:       { name: v.ownerText?.runs?.[0]?.text ?? v.shortBylineText?.runs?.[0]?.text ?? 'Unknown' },
      thumbnails:    [{ url: 'https://i.ytimg.com/vi/' + v.videoId + '/hqdefault.jpg' }],
    });
  } else {
    for (const val of Object.values(obj)) {
      if (Array.isArray(val)) val.forEach(i => findVideos(i, found));
      else if (val && typeof val === 'object') findVideos(val, found);
    }
  }
  return found;
}

async function ytSearch(query, limit = 10) {
  const data = await innertubePost('search', { query, params: 'EgIQAQ==', context: ANDROID_CTX });
  const items = findVideos(data).slice(0, limit);
  if (!items.length) throw new Error('No results found');
  return items;
}

async function ytInfo(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Invalid YouTube URL');
  const data = await getPlayerData(videoId);
  const d = data.videoDetails;
  return {
    title:     d?.title ?? 'Unknown',
    url:       'https://www.youtube.com/watch?v=' + videoId,
    duration:  parseInt(d?.lengthSeconds) || 0,
    author:    d?.author ?? 'Unknown',
    thumbnail: d?.thumbnail?.thumbnails?.slice(-1)?.[0]?.url ?? null,
  };
}

function bestAudioStream(data) {
  return (data.streamingData?.adaptiveFormats ?? [])
    .filter(f => f.mimeType?.startsWith('audio/') && f.url)
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0]?.url ?? null;
}

async function getAudioResource(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Invalid YouTube URL');
  const data = await getPlayerData(videoId);
  const audioUrl = bestAudioStream(data);
  if (!audioUrl) throw new Error('No audio stream found');
  const ffmpegProc = spawn('ffmpeg', [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', audioUrl, '-vn', '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  return createAudioResource(ffmpegProc.stdout, { inputType: StreamType.Raw });
}

async function downloadMp4(url, outputPath) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Invalid YouTube URL');
  const data = await getPlayerData(videoId);
  const adaptive = data.streamingData?.adaptiveFormats ?? [];

  const videoStream = adaptive
    .filter(f => f.mimeType?.startsWith('video/mp4') && f.url && (f.height ?? 999) <= 720)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
  const audioStream = adaptive
    .filter(f => f.mimeType?.startsWith('audio/') && f.url)
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];

  if (videoStream && audioStream) {
    const tmpV = outputPath + '_v.mp4', tmpA = outputPath + '_a.m4a';
    try {
      await streamToFile(videoStream.url, tmpV);
      await streamToFile(audioStream.url, tmpA);
      await execAsync('ffmpeg -i "' + tmpV + '" -i "' + tmpA + '" -c copy "' + outputPath + '" -y');
    } finally {
      [tmpV, tmpA].forEach(f => { try { fs.unlinkSync(f); } catch {} });
    }
    return;
  }
  const combined = (data.streamingData?.formats ?? []).find(f => f.mimeType?.startsWith('video/mp4') && f.url);
  if (!combined) throw new Error('No suitable video format found');
  await streamToFile(combined.url, outputPath);
}

async function downloadMp3(url, outputPath) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Invalid YouTube URL');
  const data = await getPlayerData(videoId);
  const audioUrl = bestAudioStream(data);
  if (!audioUrl) throw new Error('No audio stream found');
  const tmp = outputPath + '_tmp';
  try {
    await streamToFile(audioUrl, tmp);
    await execAsync('ffmpeg -i "' + tmp + '" -vn -ar 44100 -ac 2 -b:a 192k "' + outputPath + '" -y');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function streamToFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.unlink(dest, () => {});
        return streamToFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { file.close(); return reject(new Error('HTTP ' + res.statusCode)); }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
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
  client.user.setActivity('bren is cool', { type: 2 });
});

client.login(process.env.DISCORD_TOKEN);
