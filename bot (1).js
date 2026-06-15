const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const play = require('play-dl');
const ytDlp = require('yt-dlp-exec');
const fs = require('fs');
const path = require('path');

const ffmpegPath = require('ffmpeg-static');
process.env.PATH = `${path.dirname(ffmpegPath)}${path.delimiter}${process.env.PATH}`;

// ── Client setup ──────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const PREFIX = '!';
const guilds = new Map();

// ── Per-guild state ───────────────────────────────────────────────────────────
function getGuild(guildId) {
  if (!guilds.has(guildId)) {
    const player = createAudioPlayer();
    const state = { queue: [], player, connection: null, current: null, textChannel: null };

    player.on(AudioPlayerStatus.Idle, async () => {
      state.current = null;
      if (state.queue.length > 0) {
        await startPlaying(state);
      } else if (state.textChannel) {
        state.textChannel.send('✅ Queue finished!');
      }
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

// ── Audio engine ──────────────────────────────────────────────────────────────
async function startPlaying(state) {
  if (!state.queue.length || !state.connection) return;
  const track = state.queue.shift();
  state.current = track;

  try {
    const stream = await play.stream(track.url);
    const resource = createAudioResource(stream.stream, { inputType: stream.type });
    state.player.play(resource);
    if (state.textChannel) {
      state.textChannel.send({ embeds: [nowPlayingEmbed(track)] });
    }
  } catch (err) {
    console.error('Stream error:', err.message);
    if (state.textChannel) state.textChannel.send(`❌ Couldn't play **${track.title}**, skipping...`);
    if (state.queue.length > 0) await startPlaying(state);
  }
}

async function ensureVoice(message, state) {
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    await message.reply('❌ Join a voice channel first!');
    return false;
  }

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
      } catch {
        state.connection.destroy();
        state.connection = null;
      }
    });

    state.connection.subscribe(state.player);
  }

  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDuration(sec) {
  if (!sec) return 'Live';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function nowPlayingEmbed(track) {
  const embed = new EmbedBuilder()
    .setTitle('🎵 Now Playing')
    .setDescription(`[${track.title}](${track.url})`)
    .setColor(0xff0000);
  if (track.durationInSec) embed.addFields({ name: 'Duration', value: fmtDuration(track.durationInSec), inline: true });
  if (track.channel?.name) embed.addFields({ name: 'Channel', value: track.channel.name, inline: true });
  if (track.thumbnails?.[0]?.url) embed.setThumbnail(track.thumbnails[0].url);
  return embed;
}

async function resolveTrack(query) {
  if (play.yt_validate(query) === 'video') {
    const info = await play.video_info(query);
    return info.video_details;
  }
  const results = await play.search(query, { limit: 1 });
  if (!results.length) throw new Error('No results found.');
  return results[0];
}

// ── Commands ──────────────────────────────────────────────────────────────────
const commands = {};

commands.play = async (message, args) => {
  if (!args.length) return message.reply('❌ Provide a URL or search term.');
  const state = getGuild(message.guild.id);
  if (!await ensureVoice(message, state)) return;

  const status = await message.reply('🔍 Searching...');
  try {
    const details = await resolveTrack(args.join(' '));
    const track = {
      title: details.title || 'Unknown',
      url: details.url,
      durationInSec: details.durationInSec,
      channel: details.channel,
      thumbnails: details.thumbnails,
    };

    state.queue.push(track);

    if (state.player.state.status === AudioPlayerStatus.Idle) {
      await status.delete().catch(() => {});
      await startPlaying(state);
    } else {
      const embed = new EmbedBuilder()
        .setTitle('➕ Added to Queue')
        .setDescription(`[${track.title}](${track.url})`)
        .setColor(0x00bfff)
        .addFields(
          { name: 'Position', value: `#${state.queue.length}`, inline: true },
          { name: 'Duration', value: fmtDuration(track.durationInSec), inline: true }
        );
      if (track.thumbnails?.[0]?.url) embed.setThumbnail(track.thumbnails[0].url);
      await status.edit({ content: '', embeds: [embed] });
    }
  } catch (err) {
    await status.edit(`❌ Error: \`${err.message}\``);
  }
};

commands.search = async (message, args) => {
  if (!args.length) return message.reply('❌ Provide a search query.');
  const status = await message.reply('🔍 Searching YouTube...');
  try {
    const results = await play.search(args.join(' '), { limit: 5 });
    if (!results.length) return status.edit('❌ No results found.');

    const embed = new EmbedBuilder()
      .setTitle(`🔍 Results for: ${args.join(' ')}`)
      .setColor(0xff0000)
      .setFooter({ text: 'Use !play <title or URL> to queue a result' });

    results.forEach((r, i) => {
      embed.addFields({
        name: `${i + 1}. ${r.title}`,
        value: `[Watch](${r.url}) | \`${fmtDuration(r.durationInSec)}\` | ${r.channel?.name || 'Unknown'}`,
        inline: false,
      });
    });

    await status.edit({ content: '', embeds: [embed] });
  } catch (err) {
    await status.edit(`❌ Search failed: \`${err.message}\``);
  }
};

commands.download = async (message, args) => {
  if (!args.length) return message.reply('❌ Provide a URL or search term.');
  const status = await message.reply('⏳ Fetching video info...');
  const tmpDir = path.join('/tmp', `dl_${message.id}`);

  try {
    const details = await resolveTrack(args.join(' '));
    if (details.durationInSec > 600)
      return status.edit('❌ Video is over 10 minutes. Use `!play` to stream it instead.');

    await status.edit(`⏬ Downloading **${details.title}**...`);
    fs.mkdirSync(tmpDir, { recursive: true });

    await ytDlp(details.url, {
      output: path.join(tmpDir, '%(title)s.%(ext)s'),
      format: 'bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      mergeOutputFormat: 'mp4',
      noWarnings: true,
    });

    const files = fs.readdirSync(tmpDir);
    if (!files.length) return status.edit('❌ Download failed.');

    const filePath = path.join(tmpDir, files[0]);
    const sizeMB = fs.statSync(filePath).size / (1024 * 1024);

    if (sizeMB > 25)
      return status.edit(`❌ File is ${sizeMB.toFixed(1)} MB — too large. Try \`!play\` to stream it.`);

    await status.edit(`✅ Done! Sending **${details.title}** (${sizeMB.toFixed(1)} MB)...`);
    await message.channel.send({ files: [{ attachment: filePath, name: files[0] }] });
    await status.delete().catch(() => {});
  } catch (err) {
    await status.edit(`❌ Error: \`${err.message}\``);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
};

commands.audio = async (message, args) => {
  if (!args.length) return message.reply('❌ Provide a URL or search term.');
  const status = await message.reply('⏳ Fetching audio info...');
  const tmpDir = path.join('/tmp', `audio_${message.id}`);

  try {
    const details = await resolveTrack(args.join(' '));
    if (details.durationInSec > 1200)
      return status.edit('❌ Track is over 20 minutes — too long.');

    await status.edit(`⏬ Downloading audio for **${details.title}**...`);
    fs.mkdirSync(tmpDir, { recursive: true });

    await ytDlp(details.url, {
      output: path.join(tmpDir, '%(title)s.%(ext)s'),
      format: 'bestaudio/best',
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: '192K',
      noWarnings: true,
    });

    const files = fs.readdirSync(tmpDir);
    if (!files.length) return status.edit('❌ Download failed.');

    const filePath = path.join(tmpDir, files[0]);
    const sizeMB = fs.statSync(filePath).size / (1024 * 1024);

    if (sizeMB > 25) return status.edit(`❌ File is ${sizeMB.toFixed(1)} MB — too large.`);

    await status.edit(`✅ Done! Sending **${details.title}** (${sizeMB.toFixed(1)} MB)...`);
    await message.channel.send({ files: [{ attachment: filePath, name: files[0] }] });
    await status.delete().catch(() => {});
  } catch (err) {
    await status.edit(`❌ Error: \`${err.message}\``);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
};

commands.skip = async (message) => {
  const state = getGuild(message.guild.id);
  if (state.player.state.status === AudioPlayerStatus.Idle)
    return message.reply('❌ Nothing is playing.');
  state.player.stop();
  await message.reply('⏭️ Skipped!');
};

commands.queue = async (message) => {
  const state = getGuild(message.guild.id);
  if (!state.current && !state.queue.length) return message.reply('📭 The queue is empty.');

  const embed = new EmbedBuilder().setTitle('🎵 Queue').setColor(0xff0000);
  if (state.current) {
    embed.addFields({
      name: '▶️ Now Playing',
      value: `[${state.current.title}](${state.current.url}) | \`${fmtDuration(state.current.durationInSec)}\``,
      inline: false,
    });
  }
  state.queue.slice(0, 9).forEach((t, i) => {
    embed.addFields({
      name: `${i + 1}. ${t.title}`,
      value: `[Link](${t.url}) | \`${fmtDuration(t.durationInSec)}\``,
      inline: false,
    });
  });
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
  state.queue = [];
  state.player.stop(true);
  state.current = null;
  await message.reply('⏹️ Stopped and queue cleared.');
};

commands.leave = async (message) => {
  const state = getGuild(message.guild.id);
  if (!state.connection) return message.reply('❌ Not in a voice channel.');
  state.queue = [];
  state.player.stop(true);
  state.current = null;
  state.connection.destroy();
  state.connection = null;
  await message.reply('👋 Disconnected.');
};

commands.help = async (message) => {
  const embed = new EmbedBuilder()
    .setTitle('📖 Commands')
    .setColor(0xff0000)
    .addFields(
      {
        name: '🎵 Playback',
        value: '`!play` `!search` `!skip` `!pause` `!resume` `!stop` `!nowplaying` `!queue` `!leave`',
        inline: false,
      },
      {
        name: '📥 Downloads',
        value: '`!download` — MP4 video\n`!audio` — MP3 audio',
        inline: false,
      }
    )
    .setFooter({ text: 'Aliases: !p !s !dl !mp3 !np !q !dc' });
  await message.reply({ embeds: [embed] });
};

// Aliases
const aliases = {
  p: 'play', s: 'search', dl: 'download', save: 'download',
  mp3: 'audio', np: 'nowplaying', q: 'queue',
  dc: 'leave', disconnect: 'leave', next: 'skip', sk: 'skip',
};

// ── Message handler ───────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const [rawCmd, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = aliases[rawCmd.toLowerCase()] ?? rawCmd.toLowerCase();
  if (!commands[cmd]) return;

  try {
    await commands[cmd](message, args);
  } catch (err) {
    console.error(`[${cmd}] error:`, err);
    message.reply(`❌ Unexpected error: \`${err.message}\``).catch(() => {});
  }
});

client.once('ready', () => {
  console.log(`✅ Online as ${client.user.tag}`);
  client.user.setActivity('!help | YouTube', { type: 2 });
});

client.login(process.env.DISCORD_TOKEN);
