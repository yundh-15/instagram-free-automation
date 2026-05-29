import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  getConfiguredReelAudio,
  prepareReelAudioInput,
} from '../scripts/reel-audio-presets.mjs';

test('calm piano preset provides reviewable generated-audio attribution', () => {
  const audio = getConfiguredReelAudio({}, {
    REEL_AUDIO_PRESET: 'calm-piano',
    REEL_AUDIO_VOLUME: '0.12',
  });

  assert.equal(audio.preset, 'calm-piano');
  assert.equal(audio.volume, 0.12);
  assert.equal(audio.attribution.source, 'generated_audio_preset');
  assert.equal(audio.attribution.title, 'Calm Piano Bed');
  assert.match(audio.attribution.license, /Original generated audio/);
});

test('calm piano preset renders a WAV file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reel-audio-preset-'));
  try {
    const audio = getConfiguredReelAudio({}, { REEL_AUDIO_PRESET: 'calm-piano' });
    const wavPath = await prepareReelAudioInput(audio, {
      workDir: directory,
      durationSec: 1,
    });
    const wav = await readFile(wavPath);
    assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
    assert.ok(wav.length > 44);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('calm piano preset varies by seed and stays deterministic per seed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reel-audio-seeded-'));
  try {
    const audio = getConfiguredReelAudio({}, { REEL_AUDIO_PRESET: 'calm-piano' });
    const firstPath = await prepareReelAudioInput(audio, {
      workDir: directory,
      basename: 'first',
      durationSec: 1,
      seed: '2026-05-30T09:topic-a',
    });
    const repeatedPath = await prepareReelAudioInput(audio, {
      workDir: directory,
      basename: 'repeated',
      durationSec: 1,
      seed: '2026-05-30T09:topic-a',
    });
    const secondPath = await prepareReelAudioInput(audio, {
      workDir: directory,
      basename: 'second',
      durationSec: 1,
      seed: '2026-05-30T13:topic-b',
    });

    const first = await readFile(firstPath);
    const repeated = await readFile(repeatedPath);
    const second = await readFile(secondPath);
    assert.deepEqual(first, repeated);
    assert.notDeepEqual(first, second);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
