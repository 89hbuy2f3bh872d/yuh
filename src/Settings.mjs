export class SettingsManager {
  _store = new Map();
  getServer(guildId) {
    if (!this._store.has(guildId)) this._store.set(guildId, new Map());
    return this._store.get(guildId);
  }
}
