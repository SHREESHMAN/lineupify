import type { Config, DraftOptions } from '../types.js';
import { paths, readJson, writeJsonAtomic } from './store.js';

/** Spotify's dashboard rejects loopback redirect URIs without a port, so a fixed port is the default. */
export const DEFAULT_REDIRECT_PORT = 8765;

export const DEFAULT_OPTIONS: DraftOptions = {
  tracksPerTier: { headliner: 5, sub: 3, undercard: 2 },
  maxTracks: 250,
  order: 'interleave',
  excludeArtists: [],
  excludeExplicit: false,
  allowVersions: false,
  discoveryOnly: false,
  stopIfUnresolved: false,
  public: false,
  sources: ['deezer', 'lastfm', 'spotify'],
};

export async function loadConfig(): Promise<Config> {
  const cfg = (await readJson<Partial<Config>>(paths.config())) ?? {};
  return { defaults: {}, ...cfg, ...(cfg.defaults ? { defaults: cfg.defaults } : {}) } as Config;
}

export async function saveConfig(cfg: Config): Promise<void> {
  await writeJsonAtomic(paths.config(), cfg);
}

/** Env wins over config.json. */
export async function resolveSettings(): Promise<{
  clientId?: string;
  redirectPort: number;
  lastfmApiKey?: string;
  defaults: DraftOptions;
  namingTemplate: string;
}> {
  const cfg = await loadConfig();
  const port = process.env.SPOTIFY_REDIRECT_PORT ? Number(process.env.SPOTIFY_REDIRECT_PORT) : cfg.spotifyRedirectPort;
  const { namingTemplate, ...defaultsOverride } = cfg.defaults ?? {};
  return {
    clientId: process.env.SPOTIFY_CLIENT_ID?.trim() || cfg.spotifyClientId,
    redirectPort: port && Number.isFinite(port) && port > 0 ? port : DEFAULT_REDIRECT_PORT,
    lastfmApiKey: process.env.LASTFM_API_KEY?.trim() || cfg.lastfmApiKey,
    defaults: {
      ...DEFAULT_OPTIONS,
      ...defaultsOverride,
      tracksPerTier: { ...DEFAULT_OPTIONS.tracksPerTier, ...(defaultsOverride.tracksPerTier ?? {}) },
    },
    namingTemplate: namingTemplate ?? '{lineup} · Lineupify',
  };
}
