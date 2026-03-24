import path from 'path';
import type { Dirent } from 'fs';
import { readdir, rename, stat, mkdir } from 'fs/promises';
import { env } from '../config/env.js';
import { parseAnimeFilename } from '../utils/titleParser.js';

const SUBTITLE_EXTENSIONS = new Set(['.vtt', '.srt']);
const SKIP_DIRS = new Set(['Subtitles', '.animind-audio-cache']);

interface CandidateMove {
  sourceAbs: string;
  targetAbs: string;
}

function formatEpisodeFolder(episodeNumber: number): string {
  const width = episodeNumber >= 100 ? 3 : 2;
  return `Episode ${String(episodeNumber).padStart(width, '0')}`;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '-').trim();
}

function looksLikeSubtitle(fileName: string): boolean {
  return SUBTITLE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function normalizeForParse(stem: string): string {
  return stem
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLanguageSuffixes(stem: string): string[] {
  const candidates = new Set<string>([stem]);

  const languagePattern = /(english|japanese|spanish|eng|jpn|spa|rus|hindi|french|german|arabic)/i;
  const suffixPatterns = [
    /[._ -](english|japanese|spanish|eng|jpn|spa|rus|hindi|french|german|arabic)([._ -]\d+)?$/i,
    /[._ -]\d+$/,
  ];

  let current = stem;
  for (let i = 0; i < 3; i += 1) {
    let changed = false;
    for (const pattern of suffixPatterns) {
      const next = current.replace(pattern, '').trim();
      if (next !== current && next.length > 0) {
        current = next;
        candidates.add(current);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const dotParts = stem.split('.');
  if (dotParts.length > 1) {
    candidates.add(dotParts.slice(0, -1).join('.'));
  }
  if (dotParts.length > 2 && /^\d+$/.test(dotParts[dotParts.length - 1])) {
    candidates.add(dotParts.slice(0, -2).join('.'));
  }

  if (languagePattern.test(stem)) {
    candidates.add(stem.replace(languagePattern, '').replace(/[._ -]{2,}/g, ' ').trim());
  }

  return Array.from(candidates)
    .map(normalizeForParse)
    .filter(Boolean);
}

function deriveEpisodeFromSubtitleName(fileName: string): number | null {
  const stem = path.parse(fileName).name;
  const parseCandidates = stripLanguageSuffixes(stem);

  for (const candidate of parseCandidates) {
    const parsed = parseAnimeFilename(candidate);
    if (parsed?.episode && Number.isFinite(parsed.episode)) {
      return parsed.episode;
    }
  }

  return null;
}

async function walkFiles(rootDir: string, relativeDir = ''): Promise<string[]> {
  const absDir = path.join(rootDir, relativeDir);
  let entries: Dirent[];

  try {
    entries = await readdir(absDir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const relPath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...(await walkFiles(rootDir, relPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(relPath);
    }
  }

  return files;
}

async function resolveUniqueTargetPath(targetAbs: string): Promise<string> {
  const parsed = path.parse(targetAbs);
  let candidate = targetAbs;
  let counter = 2;

  while (true) {
    try {
      await stat(candidate);
      candidate = path.join(parsed.dir, `${parsed.name}.${counter}${parsed.ext}`);
      counter += 1;
    } catch {
      return candidate;
    }
  }
}

async function collectMoves(rootDir: string): Promise<CandidateMove[]> {
  const relativeFiles = await walkFiles(rootDir);
  const moves: CandidateMove[] = [];

  for (const relFile of relativeFiles) {
    const fileName = path.basename(relFile);
    if (!looksLikeSubtitle(fileName)) continue;

    const relNormalized = relFile.replace(/\\/g, '/');
    if (relNormalized.includes('/Subtitles/')) continue;

    const episode = deriveEpisodeFromSubtitleName(fileName);
    if (!episode) continue;

    const [showFolder] = relNormalized.split('/');
    if (!showFolder) continue;

    const sourceAbs = path.join(rootDir, relFile);
    const targetDir = path.join(rootDir, showFolder, 'Subtitles', formatEpisodeFolder(episode));
    const safeFileName = sanitizePathSegment(fileName);
    const targetAbsBase = path.join(targetDir, safeFileName);
    const targetAbs = await resolveUniqueTargetPath(targetAbsBase);

    if (path.normalize(sourceAbs) === path.normalize(targetAbs)) continue;

    moves.push({ sourceAbs, targetAbs });
  }

  return moves;
}

async function run(): Promise<void> {
  const isApply = process.argv.includes('--apply');

  if (env.STORAGE_MODE !== 'local') {
    console.log('[MigrateSubtitles] STORAGE_MODE is not local. Nothing to migrate.');
    return;
  }

  const rootDir = env.LOCAL_STORAGE_PATH;
  console.log(`[MigrateSubtitles] Root: ${rootDir}`);
  console.log(`[MigrateSubtitles] Mode: ${isApply ? 'APPLY' : 'DRY-RUN'}`);

  const moves = await collectMoves(rootDir);
  if (moves.length === 0) {
    console.log('[MigrateSubtitles] No legacy subtitle files detected.');
    return;
  }

  let moved = 0;
  let failed = 0;

  for (const move of moves) {
    const fromRel = path.relative(rootDir, move.sourceAbs).replace(/\\/g, '/');
    const toRel = path.relative(rootDir, move.targetAbs).replace(/\\/g, '/');

    if (!isApply) {
      console.log(`[DRY-RUN] ${fromRel} -> ${toRel}`);
      continue;
    }

    try {
      await mkdir(path.dirname(move.targetAbs), { recursive: true });
      await rename(move.sourceAbs, move.targetAbs);
      console.log(`[MOVED] ${fromRel} -> ${toRel}`);
      moved += 1;
    } catch (error: any) {
      console.warn(`[FAILED] ${fromRel} -> ${toRel} (${error?.message || String(error)})`);
      failed += 1;
    }
  }

  if (!isApply) {
    console.log(`[MigrateSubtitles] Dry-run complete. Planned moves: ${moves.length}`);
    console.log('[MigrateSubtitles] Re-run with --apply to execute.');
    return;
  }

  console.log(`[MigrateSubtitles] Completed. Moved: ${moved}, Failed: ${failed}, Total planned: ${moves.length}`);
}

run().catch((error: any) => {
  console.error('[MigrateSubtitles] Fatal error:', error?.message || String(error));
  process.exitCode = 1;
});
