'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.resolve(__dirname, '..', '.cache');
const TTL_MS = 6 * 60 * 60 * 1000; // 菜单 6 小时内复用，避免每次都打几十次 MCP

function cacheFile(storeCode) {
  return path.join(CACHE_DIR, `menu-${storeCode}.json`);
}

/** 菜单对象 -> 可 JSON 化的快照（Map 需要展开） */
function serialize(menu) {
  return {
    storeCode: menu.storeCode,
    savedAt: Date.now(),
    categories: menu.categories,
    meals: [...menu.meals.values()].map((m) => ({
      ...m,
      ingredients: m.ingredients || null,
      ingredientCodes: m.ingredientCodes ? [...m.ingredientCodes] : null,
      ingredientNames: m.ingredientNames ? [...m.ingredientNames] : null,
    })),
  };
}

function deserialize(snap) {
  const meals = new Map();
  for (const m of snap.meals) {
    meals.set(m.code, {
      ...m,
      ingredientCodes: m.ingredientCodes ? new Map(m.ingredientCodes) : null,
      ingredientNames: m.ingredientNames ? new Map(m.ingredientNames) : null,
    });
  }
  return {
    storeCode: snap.storeCode,
    categories: snap.categories || [],
    meals,
    list: [...meals.values()],
  };
}

function read(storeCode, { maxAge = TTL_MS } = {}) {
  const f = cacheFile(storeCode);
  if (!fs.existsSync(f)) return null;
  try {
    const snap = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Date.now() - (snap.savedAt || 0) > maxAge) return null;
    return deserialize(snap);
  } catch (_) {
    return null;
  }
}

function write(menu) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile(menu.storeCode), JSON.stringify(serialize(menu)), 'utf8');
  } catch (_) {
    /* 缓存失败不影响主流程 */
  }
}

function clear(storeCode) {
  const f = cacheFile(storeCode);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

module.exports = { read, write, clear, CACHE_DIR };
