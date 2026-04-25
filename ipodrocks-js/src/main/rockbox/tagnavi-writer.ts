import { Playlist, SmartPlaylistRule } from "../../shared/types";

export interface TagnaviPlaylistInput {
  playlist: Playlist;
  rules: SmartPlaylistRule[];
}

const SUPPORTED_RULE_TYPES: Record<string, string> = {
  artist: "artist",
  album: "album",
  genre: "genre",
};

// Template replicates the Rockbox firmware default tagnavi.config so we can
// own tagnavi_user.config (which overrides tagnavi.config) without losing
// the default Database menus. Our smart playlists are inlined because the
// firmware's %include of tagnavi_custom.config silently fails on some builds.
const TEMPLATE_DEFAULT_FORMATS = `# Basic format declarations
%format "fmt_title"       "%s - %02d:%02d (%s)" basename Lm Ls filename ? title == "[Untagged]"
%format "fmt_title"       "%d.%02d. %s - %02d:%02d" discnum tracknum title Lm Ls ? discnum > "0"
%format "fmt_title"       "%02d. %s - %02d:%02d" tracknum title Lm Ls ? tracknum > "0"
%format "fmt_title"       "%s - %02d:%02d" title Lm Ls
%format "fmt_alphanum_title" "%s - %02d:%02d" title Lm Ls
%format "fmt_mostplayed" "%2d|%3d %s (%s)" playcount autoscore title canonicalartist %sort = "inverse" %limit = "100"
%format "fmt_lastplayed"  "%06d%s - %s" lastplayed canonicalartist title %sort = "inverse" %limit = "99" %strip = "6"
%format "fmt_forgotten"  "%06d%s - %s" lastplayed canonicalartist title %limit = "99" %strip = "6"
%format "fmt_best_tracks" "%02d. %s (%3d)" tracknum title autoscore
%format "fmt_score"       "(%3d) %s-%s" autoscore title canonicalartist
%format "fmt_rating"       "(%2d) %s-%s" rating title canonicalartist %sort = "inverse"`;

const TEMPLATE_DEFAULT_MENUS = `%byfirstletter "custom_albumartist" "Album Artists by First Letter" "albumartist"
%byfirstletter "custom_artist" "Artists by First Letter" "canonicalartist"
%byfirstletter "custom_album" "Albums by First Letter" "album"
%byfirstletter "custom_track" "Tracks by First Letter" "title"

%menu_start "a2z" "By First Letter..."
"Album Artists" ==> "custom_albumartist"
"Artists" ==> "custom_artist"
"Albums" ==> "custom_album"
"Tracks" ==> "custom_track"

%menu_start "search" "Search by..."
"Artist" -> canonicalartist ? canonicalartist ~ "" -> album -> title = "fmt_title"
"Album Artist" -> albumartist ? albumartist ~ "" -> album -> title = "fmt_title"
"Album" -> album ? album ~ "" -> title = "fmt_title"
"Title" -> title = "fmt_title" ? title ~ ""
"Albums by Year" -> album ? year = "" -> title = "fmt_title"
"Albums between Years" -> album ? year >= "" & year <= "" -> title = "fmt_title"
"Artists between Years" -> canonicalartist ? year >= "" & year <= "" -> album -> title = "fmt_title"
"Filename" -> filename ? filename ~ ""
"Score" -> title = "fmt_score" ? autoscore > ""
"User Rating" -> title = "fmt_rating" ? rating > ""
"Comment" -> album ? comment ~ "" -> title = "fmt_title"

%menu_start "same" "Same as currently played track"
"Directory" -> title ? filename ^ "#directory#"
"Title" -> title = "fmt_title" ? title = "#title#"
"Artist" -> album ? artist = "#artist#" | artist = "#albumartist#" | albumartist = "#artist#" | albumartist = "#albumartist#" -> title  = "fmt_title"
"Album" -> title = "fmt_title" ? album = "#album#"
"Composer" -> title = "fmt_title" ? composer = "#composer#"

%menu_start "runtime" "Playback History"
"Most played (Plays|Score)" -> title = "fmt_mostplayed" ? playcount > "0"
"Recently played tracks" -> title = "fmt_lastplayed" ? playcount > "0"
"Never played tracks" -> canonicalartist ? playcount == "0" -> album -> title = "fmt_title"
"Favourite artists" -> canonicalartist ? playcount > "3" & autoscore > "85" -> album -> title = "fmt_best_tracks"
"Favourite albums" -> album ? playcount > "3" & autoscore > "85" -> title = "fmt_best_tracks"
"Recent favourites" -> title = "fmt_lastplayed" ? playcount > "3" & autoscore > "85"
"New favourites" -> canonicalartist ? playcount <= "3" & autoscore > "85" -> album -> title = "fmt_best_tracks"
"Forgotten favourites" -> title = "fmt_forgotten" ? playcount > "3" & autoscore > "85"

%menu_start "track" "Tracks by"
"Filename" -> basename
"Title" -> title
"Title (with track duration)" -> title = "fmt_alphanum_title"

%menu_start "main" "Database"
"Album Artist" -> albumartist   -> album  -> title = "fmt_title"
"Artist"   -> canonicalartist   -> album  -> title = "fmt_title"
"Album"    -> album    -> title = "fmt_title"
"Genre"    -> genre    -> canonicalartist -> album -> title = "fmt_title"
"Year"     -> year ? year > "0" -> canonicalartist -> album -> title = "fmt_title"
"Composer" -> composer -> album -> title = "fmt_title"
"First Letter" ==> "a2z"
"Tracks by"   ==> "track"
"Shuffle Songs" ~> title = "fmt_title"
"Search" ==> "search"
"User Rating" -> rating -> title = "fmt_title"
"Recently Added" -> album ? entryage < "4" & commitid > "0" -> title = "fmt_title"
"Playback History" ==> "runtime"
"Same as currently played track" ==> "same"
"Custom menu"  ==> "custom"

%root_menu "main"`;

export function sanitizeQuotedString(input: string): string {
  let s = input
    .replace(/"/g, "'")
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s;
}

export function buildEntryLine(input: TagnaviPlaylistInput): string | null {
  const { playlist, rules } = input;

  const byType: Record<string, string[]> = {};
  for (const rule of rules) {
    const tag = SUPPORTED_RULE_TYPES[rule.ruleType];
    if (!tag) {
      console.warn(`[tagnavi-writer] Unknown rule type '${rule.ruleType}' in playlist '${playlist.name}' — skipped`);
      continue;
    }
    const label = sanitizeQuotedString(rule.targetLabel ?? "");
    if (!label) {
      console.warn(`[tagnavi-writer] Empty label for rule type '${rule.ruleType}' in playlist '${playlist.name}' — skipped`);
      continue;
    }
    if (!byType[tag]) byType[tag] = [];
    byType[tag].push(label);
  }

  const clauses = Object.entries(byType).map(([tag, labels]) => {
    if (labels.length === 1) {
      return `${tag} = "${labels[0]}"`;
    }
    return `${tag} @ ${labels.map((l) => `"${l}"`).join(" ")}`;
  });

  if (clauses.length === 0) return null;

  const rawName = sanitizeQuotedString(playlist.name) || "Untitled";
  return `"${rawName}" -> title = "fmt_ipr_title" ? ${clauses.join(" & ")}`;
}

export function buildTagnaviConfig(
  inputs: TagnaviPlaylistInput[],
  opts?: { now?: () => Date }
): string {
  const now = opts?.now ? opts.now() : new Date();
  const entries: string[] = [];
  for (const input of inputs) {
    const entry = buildEntryLine(input);
    if (entry) entries.push(entry);
  }

  return [
    `#! rockbox/tagbrowser/2.0`,
    `# ^ Version header must be the first line of every file`,
    `# Generated by iPodRocks - do not edit manually`,
    `# Generated: ${now.toISOString()}`,
    ``,
    TEMPLATE_DEFAULT_FORMATS,
    ``,
    `# iPodRocks Smart playlists (inlined - %include is unreliable on some Rockbox builds)`,
    `%format "fmt_ipr_title" "%s" title`,
    ``,
    `%menu_start "custom" "iPodRocks Smart"`,
    ...entries,
    ``,
    TEMPLATE_DEFAULT_MENUS,
    ``,
  ].join("\n");
}
