function normalizeText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeEmail(value) {
  return normalizeText(value);
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function addToGroup(map, key, id) {
  if (!key) {
    return;
  }

  if (!map.has(key)) {
    map.set(key, []);
  }
  map.get(key).push(id);
}

function buildDuplicateStats(rows) {
  const groups = buildDuplicateGroups(rows);
  const duplicateCounts = {};

  groups.forEach((group) => {
    group.forEach((id) => {
      duplicateCounts[id] = group.length;
    });
  });

  return {
    duplicateIds: groups.flat(),
    duplicateCounts,
  };
}

function buildDuplicateGroups(rows) {
  const phoneGroups = new Map();
  const nameGroups = new Map();

  rows.forEach((row) => {
    addToGroup(phoneGroups, normalizeText(row.phone), row.id);

    const firmName = normalizeText(row.firmName);
    const name = normalizeText(row.name);
    const compositeKey = [firmName, name].filter(Boolean).join("|");
    addToGroup(nameGroups, compositeKey, row.id);
  });

  const relatedMap = new Map();

  function mergeGroup(ids) {
    if (!Array.isArray(ids) || ids.length < 2) {
      return;
    }

    ids.forEach((id) => {
      if (!relatedMap.has(id)) {
        relatedMap.set(id, new Set());
      }

      ids.forEach((groupId) => {
        relatedMap.get(id).add(groupId);
      });
    });
  }

  phoneGroups.forEach(mergeGroup);
  nameGroups.forEach(mergeGroup);

  const visited = new Set();
  const groups = [];

  relatedMap.forEach((set, id) => {
    if (visited.has(id)) {
      return;
    }

    const group = Array.from(set);
    group.forEach((groupId) => visited.add(groupId));

    if (group.length > 1) {
      groups.push(group);
    }
  });

  return groups;
}

module.exports = {
  normalizeText,
  normalizeEmail,
  normalizePhone,
  buildDuplicateGroups,
  buildDuplicateStats,
};
