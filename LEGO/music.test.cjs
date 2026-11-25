const assert = require('node:assert/strict');
const {test} = require('node:test');
require('./music.js');

const {QUALITY_ORDER, chordNotes, compileWord} = globalThis.LegoMusic;
const settings = {root: 'C', octave: 4, flip: 'none', density: 1, decay: 1};

test('the same pattern follows changes to the chord quality', () => {
  const word = {notes: [60, 61, 62, 64, 67, 71].map((pitch, index) => [index * 60, 60, pitch, 90])};
  const pitches = (quality) => compileWord(word, {...settings, quality}).notes.map((note) => note[2]);

  assert.deepEqual(pitches('min'), [60, 60, 63, 63, 67, 67]);
  assert.deepEqual(pitches('maj9'), [60, 60, 62, 64, 67, 71]);
  assert.deepEqual(compileWord(word, {...settings, quality: 'min'}, false).notes, word.notes);
});

test('all qualities constrain every note after transposition and variation', () => {
  const word = {notes: Array.from({length: 128}, (_, pitch) => [pitch * 60, 60, pitch, 90])};
  for (const quality of QUALITY_ORDER) {
    for (const flip of ['none', 'horizontal', 'vertical', 'diagonal']) {
      const clip = {...settings, root: 'G#', quality, flip};
      const pitchClasses = new Set(chordNotes(clip).map((pitch) => pitch % 12));
      const {notes} = compileWord(word, clip);
      assert.equal(notes.length, word.notes.length);
      for (const [, , pitch] of notes) {
        assert.ok(pitch >= 0 && pitch <= 127 && pitchClasses.has(pitch % 12), `${quality} ${flip}: ${pitch}`);
      }
    }
  }
});
