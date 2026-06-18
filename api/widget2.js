const fetch = require('node-fetch');

const BOARD_NAMES = {
  "5094371533": "MOP",
  "5094433469": "Procédures",
  "5094429442": "Formation Equipement"
};

const STATUS_COLUMN_IDS = {
  "5094371533": "color_mm3hp2dg",
  "5094433469": "color_mm3hjpm",
  "5094429442": "color_mm3h887b"
};

async function callMondayAPI(query) {
  const response = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': process.env.MONDAY_API_TOKEN,
      'API-Version': '2026-04'
    },
    body: JSON.stringify({ query })
  });
  return response.json();
}

// ─── PAGINATION GÉNÉRIQUE (cursor-based) ──────────────────────
// items_page est plafonné à 500 items par requête. Pour les boards
// susceptibles de dépasser cette limite (board central, mapping, ou
// boards dupliqués qui grossissent avec le temps), on enchaîne sur
// next_items_page jusqu'à épuisement du curseur.
// Retourne `null` si le board est supprimé/inaccessible, un tableau sinon.
async function fetchAllItems(boardId, itemFieldsFragment) {
  const firstResult = await callMondayAPI(`
    query {
      boards(ids: [${boardId}]) {
        items_page(limit: 500) {
          cursor
          items { ${itemFieldsFragment} }
        }
      }
    }
  `);

  const board = firstResult.data?.boards?.[0];
  if (!board) return null;

  let items = board.items_page?.items || [];
  let cursor = board.items_page?.cursor || null;

  while (cursor) {
    const nextResult = await callMondayAPI(`
      query {
        next_items_page(limit: 500, cursor: "${cursor}") {
          cursor
          items { ${itemFieldsFragment} }
        }
      }
    `);
    const nextPage = nextResult.data?.next_items_page;
    if (!nextPage) break;
    items = items.concat(nextPage.items || []);
    cursor = nextPage.cursor || null;
  }

  return items;
}

async function getUsersInfo(userIds) {
  if (!userIds.length) return {};
  const result = await callMondayAPI(`
    query { users(ids: [${userIds.join(',')}]) { id name photo_thumb_small } }
  `);
  const users = result.data?.users || [];
  const map = {};
  for (const u of users) map[String(u.id)] = { name: u.name, photo: u.photo_thumb_small };
  return map;
}

async function getEmployeesFromCentralBoard() {
  const items = await fetchAllItems(process.env.CENTRAL_BOARD_ID, `
    id name
    column_values {
      ... on PeopleValue {
        persons_and_teams { id kind }
      }
    }
  `) || [];

  // Extraire et dédupliquer les userIds
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    let userId = null;
    for (const col of item.column_values) {
      if (col.persons_and_teams?.length > 0) {
        const person = col.persons_and_teams.find(p => p.kind === 'person');
        if (person) { userId = person.id; break; }
      }
    }
    const key = userId || item.name;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push({ id: userId, itemName: item.name });
    }
  }

  // Une seule requête pour tous les utilisateurs
  const userIds = unique.filter(e => e.id).map(e => e.id);
  const usersMap = await getUsersInfo(userIds);

  return unique.map(e => ({
    id: e.id,
    name: e.id ? (usersMap[String(e.id)]?.name || e.itemName) : e.itemName,
    photo: e.id ? (usersMap[String(e.id)]?.photo || null) : null
  }));
}

async function getMappingFromMonday(originalBoardId) {
  const items = await fetchAllItems(process.env.MAPPING_BOARD_ID, `
    name
    column_values {
      id
      text
    }
  `) || [];

  return items
    .filter(item => String(item.name) === String(originalBoardId))
    .map(item => {
      const cols = item.column_values;
      return {
        boardDupliqueId: cols.find(c => c.id === 'text_mm45h7m7')?.text,
        userId:          cols.find(c => c.id === 'text_mm455dn5')?.text
      };
    });
}

// ─── STATUTS DYNAMIQUES ──────────────────────────────────────
// On récupère la config réelle de la colonne statut pour les labels +
// couleurs Monday, au lieu de les coder en dur. Appelé une seule fois
// par board (sur le board "original", utilisé comme référence puisque
// les boards dupliqués partagent le même statusColumnId).
//
// `settings_str` est déprécié depuis l'API 2025-10 au profit du champ
// typé `settings` (labels[] avec id / index / label / color / is_deactivated).
// On utilise donc `settings` comme source de vérité pour la liste des
// labels actifs et leur ordre d'affichage (`index`).
//
// MAIS le `color` renvoyé par `settings` est un nombre (position dans la
// palette Monday), pas un hex exploitable, et il n'existe pas de mapping
// nombre → hex officiellement documenté et stable pour les 40+ couleurs.
// On continue donc à interroger `settings_str` EN PARALLÈLE, uniquement
// pour récupérer le hex réel via `labels_colors` — ce champ fonctionne
// toujours (déprécié ≠ supprimé). Important : `labels_colors` est indexé
// par la clé legacy, qui correspond au `id` du nouveau format (pas à son
// `index`, qui lui représente la position d'affichage et peut différer
// de l'id si les labels ont été réordonnés). Le jour où monday retire
// settings_str pour de bon, il faudra constituer une palette statique de
// secours (numéro de couleur → hex) à la place de ce fallback.
function extractColor(colorEntry) {
  if (!colorEntry) return null;
  if (typeof colorEntry === 'string') return colorEntry;
  return colorEntry.color || colorEntry.hex || null;
}

async function getStatusDefs(boardId, statusColumnId) {
  const result = await callMondayAPI(`
    query {
      boards(ids: [${boardId}]) {
        columns(ids: ["${statusColumnId}"]) {
          settings
          settings_str
        }
      }
    }
  `);

  const column = result.data?.boards?.[0]?.columns?.[0];
  if (!column) return [];

  const typedLabels = Array.isArray(column.settings?.labels) ? column.settings.labels : null;

  // Couleurs hex récupérées via le format legacy (clé = id du label)
  let legacyColors = {};
  if (column.settings_str) {
    try {
      legacyColors = JSON.parse(column.settings_str).labels_colors || {};
    } catch {
      console.error('Impossible de parser settings_str:', column.settings_str);
    }
  }

  if (typedLabels) {
    return typedLabels
      .filter(l => !l.is_deactivated && l.label) // on ignore les labels désactivés/vides
      .sort((a, b) => a.index - b.index)         // ordre d'affichage Monday
      .map(l => ({
        key:   l.label, // le texte du label sert de clé (stable, unique dans la colonne)
        label: l.label,
        color: extractColor(legacyColors[l.id]) || '#c4c4c4'
      }));
  }

  // Filet de secours si `settings` est vide pour cette colonne (rare) :
  // on retombe sur l'ancien format intégral de settings_str.
  if (!column.settings_str) return [];

  let legacy;
  try {
    legacy = JSON.parse(column.settings_str);
  } catch {
    console.error('Impossible de parser settings_str:', column.settings_str);
    return [];
  }

  const labels    = legacy.labels || {};
  const colors    = legacy.labels_colors || {};
  const positions = legacy.labels_positions_v2 || {};

  const indices = Object.keys(labels).sort((a, b) => {
    const posA = positions[a] ?? Number(a);
    const posB = positions[b] ?? Number(b);
    return posA - posB;
  });

  return indices
    .filter(idx => labels[idx])
    .map(idx => ({
      key:   labels[idx],
      label: labels[idx],
      color: extractColor(colors[idx]) || '#c4c4c4'
    }));
}

async function getEmployeeProgress(boardId, statusColumnId, statusDefs) {
  const counts = {};
  statusDefs.forEach(def => { counts[def.key] = 0; });

  if (!boardId) return { counts, total: 0 };

  const items = await fetchAllItems(boardId, `
    column_values(ids: ["${statusColumnId}"]) {
      type
      ... on StatusValue { label }
    }
  `);

  // Board supprimé ou inaccessible → tout à 0
  if (items === null) {
    return { counts, total: 0 };
  }

  let total = 0;

  for (const item of items) {
    for (const col of item.column_values) {
      // NB : on garde le check 'color' en filet de sécurité. Sur certaines
      // colonnes Status (notamment celles avec un id préfixé "color_",
      // comme les tiennes), monday peut encore renvoyer "color" comme
      // valeur de `type` selon le contexte — c'est documenté pour les
      // erreurs ColumnValueException, mais pas garanti à 100% sur ce champ
      // précis sans test direct sur tes boards. Tu peux retirer cette
      // branche si tu vérifies que `type` renvoie bien toujours "status"
      // sur tes colonnes réelles.
      if (col.type === 'status' || col.type === 'color') {
        const label = col.label || ''; // '' = item sans statut défini
        counts[label] = (counts[label] || 0) + 1;
        total++;
      }
    }
  }

  return { counts, total };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    const boardName = req.query.board || 'MOP';
    const originalBoardId = Object.keys(BOARD_NAMES).find(id => BOARD_NAMES[id] === boardName);
    if (!originalBoardId) return res.json({ boardName, statusDefs: [], employees: [] });

    const statusColumnId = STATUS_COLUMN_IDS[originalBoardId];

    // Mapping + employés + statuts en parallèle
    const [mappingRows, centralEmployees, statusDefs] = await Promise.all([
      getMappingFromMonday(originalBoardId),
      getEmployeesFromCentralBoard(),
      getStatusDefs(originalBoardId, statusColumnId)
    ]);

    // Tous les getEmployeeProgress en parallèle
    const employees = await Promise.all(centralEmployees.map(async emp => {
      const row = mappingRows.find(r => String(r.userId) === String(emp.id));
      if (!row) {
        const emptyCounts = {};
        statusDefs.forEach(d => { emptyCounts[d.key] = 0; });
        return { name: emp.name, photo: emp.photo, total: 0, counts: emptyCounts };
      }
      const { counts, total } = await getEmployeeProgress(row.boardDupliqueId, statusColumnId, statusDefs);
      return { name: emp.name, photo: emp.photo, total, counts };
    }));

    // Filet de sécurité : si un item a un statut absent des statusDefs
    // (édition manuelle, colonne désynchronisée...), on l'ajoute quand même
    // pour ne perdre aucune donnée dans le widget.
    const allKeys = new Set(statusDefs.map(d => d.key));
    employees.forEach(e => Object.keys(e.counts).forEach(k => allKeys.add(k)));

    const finalStatusDefs = Array.from(allKeys).map(key => {
      const existing = statusDefs.find(d => d.key === key);
      if (existing) return existing;
      return { key, label: key || 'Sans statut', color: '#c4c4c4' };
    });

    const normalizedEmployees = employees.map(e => {
      const counts = {};
      finalStatusDefs.forEach(d => { counts[d.key] = e.counts[d.key] || 0; });
      return { name: e.name, photo: e.photo, total: e.total, counts };
    });

    return res.json({ boardName, statusDefs: finalStatusDefs, employees: normalizedEmployees });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
