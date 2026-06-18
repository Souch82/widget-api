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
  const result = await callMondayAPI(`
    query {
      boards(ids: [${process.env.CENTRAL_BOARD_ID}]) {
        items_page(limit: 500) {
          items {
            id name
            column_values {
              ... on PeopleValue {
                persons_and_teams { id kind }
              }
            }
          }
        }
      }
    }
  `);

  const items = result.data?.boards[0]?.items_page?.items || [];

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
  const result = await callMondayAPI(`
    query {
      boards(ids: [${process.env.MAPPING_BOARD_ID}]) {
        items_page(limit: 500) {
          items {
            name
            column_values {
              id
              text
            }
          }
        }
      }
    }
  `);

  const items = result.data?.boards[0]?.items_page?.items || [];
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
// Va chercher la config réelle de la colonne statut (settings_str) pour
// récupérer labels + couleurs Monday, au lieu de les coder en dur.
// Appelé une seule fois par board (sur le board "original", utilisé comme
// référence puisque les boards dupliqués partagent le même statusColumnId).

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
          settings_str
        }
      }
    }
  `);

  const settingsStr = result.data?.boards?.[0]?.columns?.[0]?.settings_str;
  if (!settingsStr) return [];

  let settings;
  try {
    settings = JSON.parse(settingsStr);
  } catch {
    console.error('Impossible de parser settings_str:', settingsStr);
    return [];
  }

  const labels    = settings.labels || {};
  const colors    = settings.labels_colors || {};
  const positions = settings.labels_positions_v2 || {};

  // Ordre d'affichage Monday si dispo, sinon ordre des index
  const indices = Object.keys(labels).sort((a, b) => {
    const posA = positions[a] ?? Number(a);
    const posB = positions[b] ?? Number(b);
    return posA - posB;
  });

  return indices
    .filter(idx => labels[idx]) // ignore les slots vides du settings
    .map(idx => ({
      key:   labels[idx],   // le texte du label sert de clé (stable, unique dans la colonne)
      label: labels[idx],
      color: extractColor(colors[idx]) || '#c4c4c4'
    }));
}

async function getEmployeeProgress(boardId, statusColumnId, statusDefs) {
  const counts = {};
  statusDefs.forEach(def => { counts[def.key] = 0; });

  if (!boardId) return { counts, total: 0 };

  const result = await callMondayAPI(`
    query {
      boards(ids: [${boardId}]) {
        items_page(limit: 500) {
          items {
            column_values(ids: ["${statusColumnId}"]) {
              type
              ... on StatusValue { label }
            }
          }
        }
      }
    }
  `);

  // Board supprimé ou inaccessible → tout à 0
  if (!result.data?.boards?.length || !result.data.boards[0]) {
    return { counts, total: 0 };
  }

  const items = result.data.boards[0]?.items_page?.items || [];
  let total = 0;

  for (const item of items) {
    for (const col of item.column_values) {
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

    // Filet de sécurité : si un item a un statut absent de settings_str
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
