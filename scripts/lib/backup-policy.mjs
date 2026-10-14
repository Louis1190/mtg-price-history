// Which snapshots of the published state to keep (see backup.mjs and README.md, "Backups").
//
// Why snapshots exist: the working state is ONE release asset replaced every day, so there is a single copy of our history,
// and MTGJSON only keeps 90 days: whatever is older exists nowhere else. A snapshot a week, the last eight kept, lets a bad day
// that passed every check, or a corrupted state, be rolled back to a set at most a week old, which the resync then brings up
// to date from MTGJSON's 90-day file (README.md, "Restoring").

export const BACKUP_NAME = /^state-(\d{4}-\d{2}-\d{2})\.tar$/;

const DAY_MS = 86400000;
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * assets: the names of the assets of the backups release. asOf: the day of the set to save.
 * Returns { take, name, prune }: whether to save a snapshot of `asOf` (none yet, or the newest is `everyDays` or more older),
 * its file name, and the names to delete afterwards so that at most `keep` remain. Assets that are not snapshots are never touched.
 */
export function planBackup({ assets, asOf, everyDays = 7, keep = 8 }) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`))) throw new Error(`not a day: ${asOf}`);
	const snapshots = assets.filter((n) => BACKUP_NAME.test(n)).sort();
	const newest = snapshots.at(-1);
	const take = newest === undefined || daysBetween(BACKUP_NAME.exec(newest)[1], asOf) >= everyDays;
	const name = `state-${asOf}.tar`;
	const after = take ? [...snapshots, name].sort() : snapshots;
	return { take, name, prune: after.slice(0, Math.max(0, after.length - keep)) };
}
