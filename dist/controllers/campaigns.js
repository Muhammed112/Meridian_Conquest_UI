import { cloudEnabled } from '../cloud.js?v=match-commentary-20261026-1';
import { LocalGameRepository } from '../engine.js';
import { extendsHistory } from '../campaign-history.js';

/** Coordinate lazy campaign loading and local recovery without owning auth or game rules. */
export function createCampaignController(context) {
  const pending = new Map();
  const status = (id) => context.cloud?.campaignState?.(id)?.status || 'ready';
  const isReady = (game) =>
    !cloudEnabled || Boolean(context.cloudReady && game && status(game.id) === 'ready');

  /** Persist complete histories only; opening one game must not replace other recovery copies. */
  function persistCache() {
    const saved = new Map((context.repository.load() || []).map((game) => [game.id, game]));
    const complete = context.games.flatMap((game) => {
      const value = isReady(game) ? game : saved.get(game.id);
      saved.delete(game.id);
      return value ? [value] : [];
    });
    return context.repository.save([...complete, ...saved.values()]);
  }

  /** Retain a competing local branch separately before replacing the visible cloud campaign. */
  function preserveRecovery(game, uid) {
    if (!game?.events?.length) return;
    const key = `meridian-recovery-${uid}-${game.id}-${game.updatedAt}-${game.events.at(-1).id}`;
    if (!new LocalGameRepository(key).save([game]))
      throw new Error(
        'Browser recovery storage is unavailable. Keep this page open to retain your progress.',
      );
  }

  /** Reconcile only a genuine extension; competing histories are retained as recovery copies. */
  async function load(id, { retry = false } = {}) {
    const cloud = context.cloud;
    if (!cloud?.user || !cloud.ready || !cloud.openCampaign) return null;
    const uid = cloud.user.uid;
    const key = uid + '/' + id;
    if (pending.has(key)) return pending.get(key);
    if (!retry && ['error', 'conflict'].includes(status(id))) return null;
    const request = (async () => {
      const previous = context.games.find((game) => game.id === id);
      if (retry) preserveRecovery(previous, uid);
      const remote = await cloud.openCampaign(id, { retry });
      if (!remote || context.cloud !== cloud || cloud.user?.uid !== uid) return null;
      const local = context.games.find((game) => game.id === id);
      // A newer timestamp alone is insufficient: local history must extend the remote branch.
      const retainLocal =
        !retry &&
        local &&
        local.updatedAt >= remote.updatedAt &&
        extendsHistory(local.events || [], remote.events);
      if (!retry && !retainLocal && local && !extendsHistory(remote.events, local.events || []))
        preserveRecovery(local, uid);
      const game = retainLocal ? local : remote;
      cloud.restoreCommentary?.(game);
      context.games = [...context.games.filter((item) => item.id !== id), game].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      );
      persistCache();
      context.render();
      if (context.state.gameId === id && context.state.view === 'game') {
        void cloud.prepareCommentary?.();
        context.save();
        queueMicrotask(context.runNPCs);
      }
      return game;
    })().finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  }

  /** Only the selected private game needs history or AI preparation. */
  async function open(options) {
    const { state, cloud } = context;
    if (
      !['game', 'history'].includes(state.view) ||
      state.watch ||
      state.liveShareId ||
      !state.gameId
    )
      return;
    try {
      if (state.view === 'game') void cloud?.prepareCommentary?.();
      await load(state.gameId, options);
      if (isReady(context.currentGame()) && state.view === 'game')
        void cloud?.prepareCommentary?.();
    } catch (error) {
      context.notify(error.message);
      context.render();
    }
  }
  return { open, load, status, isReady, persistCache };
}
