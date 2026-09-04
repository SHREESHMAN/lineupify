/**
 * Helpers shared by tool handlers: result formatting, error mapping, draft
 * loading that respects a job running in this process.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Draft } from '../types.js';
import { LineupifyError } from '../types.js';
import { log } from '../infra/log.js';
import { clean } from '../infra/text.js';
import { liveDraft, lockedElsewhere, startJob } from '../engine/jobs.js';
import { hasPendingWork, loadDraft, saveDraft } from '../engine/draft.js';
import { resolveSettings } from '../infra/config.js';
import { loadTokens } from '../sources/spotify.js';

export function text(s: string): CallToolResult {
  return { content: [{ type: 'text', text: s }] };
}

export function fail(err: unknown): CallToolResult {
  if (err instanceof LineupifyError) {
    const parts = [`${err.code}: ${clean(err.message, 300)}`];
    if (err.hint) parts.push(`Fix: ${clean(err.hint, 300)}`);
    return { content: [{ type: 'text', text: parts.join('\n') }], isError: true };
  }
  const msg = err instanceof Error ? err.message : String(err);
  log.error('tool failed', msg);
  return { content: [{ type: 'text', text: `ERROR: ${clean(msg, 300)}` }], isError: true };
}

/** Wrap a handler so thrown errors become compact error results. */
export function guard<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err);
    }
  };
}

/**
 * Load a draft for reading or editing. Prefers the in-memory copy of a job
 * running in this process so edits and checkpoints don't clobber each other.
 */
export async function getDraft(id: string): Promise<Draft> {
  const live = liveDraft(id);
  if (live) return live;
  const d = await loadDraft(id);
  if (!d) throw new LineupifyError('DRAFT_NOT_FOUND', `No draft with id ${id}.`, 'Call list_drafts to see available drafts.');
  return d;
}

/** Persist a draft unless a job in this process owns it (the job checkpoints itself). */
export async function persist(d: Draft, bump: boolean, previous?: Draft): Promise<void> {
  if (liveDraft(d.id) === d) {
    if (bump) d.revision += 1;
    return;
  }
  await saveDraft(d, { bump, previous });
}

export async function ensureNotLockedElsewhere(id: string): Promise<void> {
  if (await lockedElsewhere(id)) {
    throw new LineupifyError('DRAFT_BUILDING_ELSEWHERE', 'Another Lineupify instance is building this draft right now.', 'Wait a minute and try again, or read it with get_draft.');
  }
}

/** Resume an interrupted build if the draft still has pending artists. */
export async function maybeResume(d: Draft): Promise<void> {
  if (d.status === 'ready' || d.status === 'failed') return;
  if (!hasPendingWork(d)) return;
  const tokens = await loadTokens();
  if (!tokens) return;
  const settings = await resolveSettings();
  const r = await startJob(d.id, { lastfmApiKey: settings.lastfmApiKey }, liveDraft(d.id) ?? d);
  if (r === 'started') log.info(`resumed build of ${d.id}`);
}

export function connectedName(tokens: { displayName: string; userId: string } | undefined): string | undefined {
  return tokens ? tokens.displayName || tokens.userId : undefined;
}

/** LINEUPIFY_READ_ONLY=1 turns every Spotify write off: drafts still build, nothing is created or changed in the account. */
export function readOnlyMode(): boolean {
  const v = (process.env.LINEUPIFY_READ_ONLY ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function ensureWritesAllowed(what: string): void {
  if (readOnlyMode()) {
    throw new LineupifyError('READ_ONLY_MODE', `${what} is disabled: Lineupify is running with LINEUPIFY_READ_ONLY set.`, 'Remove LINEUPIFY_READ_ONLY from the MCP server config and restart the host to allow writes to Spotify. Drafts and exports still work.');
  }
}

export function clampInt(n: number | undefined, min: number, max: number, dflt: number): number {
  if (n === undefined || !Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
