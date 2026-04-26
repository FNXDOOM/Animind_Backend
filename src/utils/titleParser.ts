/**
 * titleParser.ts
 *
 * Extracts a clean anime title and episode number from messy release filenames.
 * Examples:
 *   "[SubsPlease] Frieren - 01 (1080p) [Hash].mkv"  → { title: "Frieren", episode: 1 }
 *   "Naruto Shippuden S01E04.mkv"                   → { title: "Naruto Shippuden", episode: 4 }
 *   "One Piece - 1000.mp4"                          → { title: "One Piece", episode: 1000 }
 */

export interface ParsedAnime {
  title: string;
  episode: number;
  season?: number;
  quality?: string;
  group?: string;
}

// Remove extension
function stripExtension(name: string): string {
  return name.replace(/\.[a-z0-9]{2,4}$/i, '');
}

// Strip common release group tags like [SubsPlease], [HorribleSubs]
function stripGroupTag(name: string): { cleaned: string; group?: string } {
  const match = name.match(/^\[([^\]]+)\]\s*(.*)/);
  if (match) return { cleaned: match[2], group: match[1] };
  return { cleaned: name };
}

// Strip trailing noise: quality, hash, etc. e.g. "(1080p) [ABCD1234]"
function stripTrailingNoise(name: string): string {
  return name
    .replace(/[._]+/g, ' ')              // dots/underscores used as separators
    .replace(/\s*\([^)]*\)\s*/g, ' ')    // (1080p), (BD), etc.
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')   // [Hash], [AAC], etc.
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Clean a folder name that may contain release-group noise.
 * e.g. "Re.ZERO.Starting.Life.in.Another.World.S03.1080p.BluRay.Opus.2.0.x265-Headpatter"
 *   → "Re ZERO Starting Life in Another World"
 * Strips everything from the first quality/codec/season marker onward.
 */
function cleanFolderTitle(folderName: string): string {
  // Replace dots/underscores with spaces first
  let name = folderName.replace(/[._]+/g, ' ');

  // Strip everything from a season marker (S01, S03 …) onward
  name = name.replace(/\s+[Ss]\d{1,2}\b.*$/i, '');

  // Strip everything from a quality tag onward (480p, 720p, 1080p, 2160p, BluRay, WEB-DL …)
  name = name.replace(/\s+(\d{3,4}p|BluRay|WEBRip|WEB-DL|HDTV|BDRip|DVDRip|x264|x265|HEVC|AVC|AAC|Opus|FLAC|H\.?264|H\.?265)\b.*/i, '');

  // Strip trailing release-group suffix after a hyphen (e.g. "-Headpatter")
  name = name.replace(/\s+-\s*\S+\s*$/, '');

  return name.trim();
}

// Try to extract episode number in patterns like: "- 01", "E01", "Episode 01", " 01 "
function extractEpisode(name: string): { title: string; episode: number; season?: number } | null {
  // Pattern: "Title - 01" or "Title – 01"
  let m = name.match(/^(.+?)\s*[-–]\s*(\d{1,4})\s*$/);
  if (m) return { title: m[1].trim(), episode: parseInt(m[2], 10) };

  // Pattern: bare SxxExx or SxxExxvN (filename without title)
  m = name.match(/^[Ss](\d{1,2})[Ee](\d{1,4})(?:[Vv]\d+)?$/i);
  if (m) return { title: '', season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };

  // Pattern: SxxExx and SxxExxvN (e.g. S03E01v3)
  m = name.match(/^(.+?)\s*(?:[-–]\s*)?[Ss](\d{1,2})[Ee](\d{1,4})(?:[Vv]\d+)?\b/i);
  if (m) return { title: m[1].trim(), season: parseInt(m[2], 10), episode: parseInt(m[3], 10) };

  // Pattern: "Episode 01" / "Ep01"
  m = name.match(/^(.+?)\s*[Ee]p(?:isode)?\s*(\d{1,4})\s*$/);
  if (m) return { title: m[1].trim(), episode: parseInt(m[2], 10) };

  // Pattern: trailing number "Title 01"
  m = name.match(/^(.+?)\s+(\d{1,4})\s*$/);
  if (m) return { title: m[1].trim(), episode: parseInt(m[2], 10) };

  return null;
}

function extractSeasonFromPathParts(parts: string[]): number | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]?.trim();
    if (!part) continue;

    let match = part.match(/^season\s*(\d{1,2})$/i);
    if (match) return parseInt(match[1], 10);

    match = part.match(/\bseason\s*(\d{1,2})\b/i);
    if (match) return parseInt(match[1], 10);

    match = part.match(/^s(\d{1,2})$/i);
    if (match) return parseInt(match[1], 10);
  }

  return undefined;
}

function stripSeasonSuffix(title: string): string {
  return title
    .replace(/\s*[-–]\s*season\s*\d{1,2}\s*$/i, '')
    .replace(/\s*season\s*\d{1,2}\s*$/i, '')
    .trim();
}

export function parseAnimeFilename(filename: string): ParsedAnime | null {
  try {
    let name = stripExtension(filename);
    const { cleaned, group } = stripGroupTag(name);
    name = stripTrailingNoise(cleaned);

    // Detect quality string for reference
    const qualityMatch = filename.match(/\b(480p|720p|1080p|2160p|4K|BD|BluRay|WEB-DL)\b/i);
    const quality = qualityMatch?.[1];

    const parsed = extractEpisode(name);
    if (!parsed) return null;

    return {
      title: parsed.title,
      episode: parsed.episode,
      season: parsed.season,
      quality,
      group,
    };
  } catch {
    return null;
  }
}

/**
 * Derive a show title from a folder path like:
 *   "Frieren/Season 1/S01E01.mkv"  → "Frieren"
 *   "Naruto Shippuden/E01.mkv"     → "Naruto Shippuden"
 *
 * Falls back to filename parsing.
 */
export function parseFolderPath(relativePath: string): ParsedAnime | null {
  const parts = relativePath.replace(/\\/g, '/').split('/');
  const filename = parts[parts.length - 1];
  const folderTitle = parts.length > 1 ? parts[0] : null;
  const seasonFromPath = extractSeasonFromPathParts(parts.slice(0, -1));

  const parsed = parseAnimeFilename(filename);
  if (!parsed) return null;

  if (!parsed.season && seasonFromPath) {
    parsed.season = seasonFromPath;
  }

  // Prefer folder name as title if it looks meaningful
  if (folderTitle && folderTitle.length > 1 && !/^season/i.test(folderTitle)) {
    const cleanedFolder = cleanFolderTitle(folderTitle.trim());
    parsed.title = stripSeasonSuffix(cleanedFolder) || cleanedFolder || folderTitle.trim();
  } else if (!parsed.title) {
    return null;
  }

  return parsed;
}
