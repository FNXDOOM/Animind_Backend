import { describe, expect, it } from 'vitest';
import { parseAnimeFilename, parseFolderPath } from '../src/utils/titleParser.js';

describe('titleParser season-aware parsing', () => {
  it('parses SxxExx with revision suffix', () => {
    const parsed = parseAnimeFilename('[FLE] Re ZERO - S03E01v3 (WEB 1080p).mkv');

    expect(parsed).not.toBeNull();
    expect(parsed?.episode).toBe(1);
    expect(parsed?.season).toBe(3);
  });

  it('derives season from folder path when filename has no season token', () => {
    const parsed = parseFolderPath('Show Name/Season 2/Show Name - 07.mkv');

    expect(parsed).not.toBeNull();
    expect(parsed?.title).toBe('Show Name');
    expect(parsed?.episode).toBe(7);
    expect(parsed?.season).toBe(2);
  });

  it('strips season suffix from top-level folder title', () => {
    const parsed = parseFolderPath('Re ZERO Starting Life in Another World - Season 3/S03E02.mkv');

    expect(parsed).not.toBeNull();
    expect(parsed?.title).toBe('Re ZERO Starting Life in Another World');
    expect(parsed?.episode).toBe(2);
    expect(parsed?.season).toBe(3);
  });

  it('reads embedded season markers from noisy release folder names', () => {
    const parsed = parseFolderPath(
      "Frieren.Beyond.Journey's.End.S01.2160p.WEB-DL.Multi.AUDIO.x265.Multi.Subs/Frieren - 04.mkv"
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.title).toBe("Frieren Beyond Journey's End");
    expect(parsed?.episode).toBe(4);
    expect(parsed?.season).toBe(1);
  });

  it('classifies special release folders as non-tv content', () => {
    const parsed = parseFolderPath('Frieren Specials/Frieren - 01.mkv');

    expect(parsed).not.toBeNull();
    expect(parsed?.contentType).toBe('special');
  });
});
