import express from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import toneMidi from '@tonejs/midi';
import { PARAMETER_FILENAME, createParameterFile, normalizeParameterFile } from './src/parameters.js';
const { Midi } = toneMidi;

const root = path.dirname(fileURLToPath(import.meta.url));
const datasetRoot = path.join(root, 'POP909');
const classicalRoot = path.join(root, '..', 'midi-presets', 'classical');
const parameterPath = path.join(root, PARAMETER_FILENAME);
const app = express();
app.use(cors());
app.use('/music-preview', express.static(path.join(root, '..', 'ActiveBasis', 'web', 'public', 'music-preview')));
app.use(express.json({ limit: '32kb' }));

let catalogPromise;
async function getCatalog() {
  catalogPromise ??= (async () => {
    const absentCollection = (error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    };
    const [entries, names, classical] = await Promise.all([
      fs.readdir(datasetRoot, { withFileTypes: true }).catch(absentCollection),
      // Song IDs and titles exported from POP909/index.xlsx.
      fs.readFile(path.join(root, 'pop909-titles.json'), 'utf8').then(JSON.parse),
      fs.readFile(path.join(classicalRoot, 'index.json'), 'utf8').then(JSON.parse).catch(absentCollection),
    ]);
    const songs = [];
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const files = await fs.readdir(path.join(datasetRoot, entry.name));
      const main = files.find((name) => name.toLowerCase() === `${entry.name.toLowerCase()}.mid`)
        ?? files.find((name) => /\.midi?$/i.test(name));
      if (main) songs.push({ id: entry.name, name: names[entry.name] ?? entry.name, file: main });
    }
    return [...songs, ...classical.map((song) => ({ ...song, collection: 'classical' }))];
  })();
  return catalogPromise;
}

app.get('/api/songs', async (_req, res) => {
  try { res.json(await getCatalog()); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/parameters', async (_req, res) => {
  try {
    const document = normalizeParameterFile(JSON.parse(await fs.readFile(parameterPath, 'utf8')));
    res.json({ exists: true, filename: PARAMETER_FILENAME, document });
  } catch (error) {
    if (error.code === 'ENOENT') return res.json({ exists: false, filename: PARAMETER_FILENAME });
    res.status(500).json({ error: `无法读取 ${PARAMETER_FILENAME}：${error.message}` });
  }
});

app.put('/api/parameters', async (req, res) => {
  try {
    const document = createParameterFile(req.body?.parameters);
    await fs.writeFile(parameterPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    res.json({ exists: true, filename: PARAMETER_FILENAME, document });
  } catch (error) {
    res.status(400).json({ error: `参数未保存：${error.message}` });
  }
});

const midiLimit = '2mb';
const trackSignature = (notes) => createHash('sha256').update(JSON.stringify(notes
  .map(({ ticks, durationTicks, midi }) => [ticks, ticks + durationTicks, midi])
  .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]))).digest('hex');

function describeMidi(buffer, name, catalogId = null) {
    if (buffer.subarray(0, 4).toString() !== 'MThd') throw new Error('请选择有效的 MIDI 文件');
    const midi = new Midi(buffer);
    const sourceId = createHash('sha256').update(buffer).digest('hex');
    const id = catalogId ?? sourceId;
    if (!(midi.header.ppq > 0)) throw new Error('MIDI 必须使用每拍刻度');
    const tracks = midi.tracks.map((track, index) => {
      const notes = track.notes.map((note, noteIndex) => ({
        id: `${sourceId}:${index}:${noteIndex}`,
        midi: note.midi,
        name: note.name,
        velocity: Math.round(note.velocity * 127),
        ticks: note.ticks,
        durationTicks: note.durationTicks,
      }));
      return {
        id: `${sourceId}:${index}`, index, name: track.name || `Track ${index + 1}`,
        instrument: track.instrument?.name || 'unknown', channel: track.channel,
        notes, signature: trackSignature(notes),
      };
    }).filter((track) => track.notes.length);
    if (!tracks.length) throw new Error('MIDI 中没有带完整音符的音轨');
    return {
      id, name, sourceId, catalogId,
      sourcePpq: midi.header.ppq,
      tempos: midi.header.tempos,
      tracks,
    };
}

app.get('/api/midi/:id', async (req, res) => {
  try {
    const songs = await getCatalog();
    const song = songs.find((item) => item.id === req.params.id);
    if (!song) return res.status(404).json({ error: 'Song not found' });
    const directory = song.collection === 'classical' ? classicalRoot : path.join(datasetRoot, song.id);
    const buffer = await fs.readFile(path.join(directory, song.file));
    if (req.query.raw === '1') return res.type('audio/midi').send(buffer);
    res.json(describeMidi(buffer, song.name, song.id));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/midi', express.raw({ type: 'application/octet-stream', limit: midiLimit }), (req, res) => {
  try {
    const name = path.basename(String(req.query.name || 'upload.mid').slice(0, 255));
    res.json(describeMidi(req.body, name));
  } catch (error) { res.status(400).json({ error: error.message || 'MIDI 解析失败' }); }
});

if (process.argv.includes('--production')) app.use(express.static(path.join(root, 'dist')));
const host = process.env.BPE_HOST || '127.0.0.1';
const port = Number(process.env.BPE_PORT ?? 4174);
const server = app.listen(port, host, (error) => {
  if (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  console.log('BPE data server listening on http://' + host + ':' + server.address().port);
});
