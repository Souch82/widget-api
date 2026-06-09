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
      'API-Version': '2024-01'
    },
    body: JSON.stringify({ query })
  });
  return response.json();
}

async function getUserInfo(userId) {
  const result = await callMondayAPI(`
    query { users(ids: [${userId}]) { name photo_thumb_small } }
  `);
  if (!result.data?.users?.length) return { name: null, photo: null };
  return {
    name: result.data.users[0].name,
    photo: result.data.users[0].photo_thumb_small
  };
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

  // Extraire les userIds
  const rawEmployees = items.map(item => {
    let userId = null;
    for (const col of item.column_values) {
      if (col.persons_and_teams?.length > 0) {
        const person = col.persons_and_teams.find(p => p.kind === 'person');
        if (person) { userId = person.id; break; }
      }
    }
    return { id: userId, itemName: item.name };
  });

  // Dédupliquer par userId
  const seen = new Set();
  const unique = rawEmployees.filter(e => {
    const key = e.id || e.itemName;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Récupérer les infos utilisateur en parallèle
  const employees = await Promise.all(unique.map(async e => {
    const userInfo = e.id ? await getUserInfo(e.id) : { name: e.itemName, photo: null };
    return { id: e.id, name: userInfo.name || e.itemName, photo: userInfo.photo };
  }));

  return employees;
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
async function getEmployeeProgress(boardId, statusColumnId) {
  if (!boardId) return { forme: 0, enCours: 0, nonCommence: 0, total: 0 };
  
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

  // Board supprimé ou inaccessible → retourner 0
  if (!result.data?.boards?.length || !result.data.boards[0]) {
    return { forme: 0, enCours: 0, nonCommence: 0, total: 0 };
  }

  const items = result.data.boards[0]?.items_page?.items || [];
  let forme = 0, enCours = 0, nonCommence = 0;

  for (const item of items) {
    for (const col of item.column_values) {
      if (col.type === 'status' || col.type === 'color') {
        const label = (col.label || '').toLowerCase().trim();
        if (label === 'formé') forme++;
        else if (label === 'en cours') enCours++;
        else nonCommence++;
      }
    }
  }

  return { forme, enCours, nonCommence, total: forme + enCours + nonCommence };
}
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    const boardName = req.query.board || 'MOP';
    const originalBoardId = Object.keys(BOARD_NAMES).find(id => BOARD_NAMES[id] === boardName);
    if (!originalBoardId) return res.json({ boardName, employees: [] });

    const statusColumnId = STATUS_COLUMN_IDS[originalBoardId];

    // Lancer mapping + employés en parallèle
    const [mappingRows, centralEmployees] = await Promise.all([
      getMappingFromMonday(originalBoardId),
      getEmployeesFromCentralBoard()
    ]);

    // Lancer tous les getEmployeeProgress en parallèle
    const employees = await Promise.all(centralEmployees.map(async emp => {
      const row = mappingRows.find(r => String(r.userId) === String(emp.id));
      if (!row) return { name: emp.name, photo: emp.photo, forme: 0, enCours: 0, nonCommence: 0, total: 0 };
      const stats = await getEmployeeProgress(row.boardDupliqueId, statusColumnId);
      return { name: emp.name, photo: emp.photo, ...stats };
    }));

    return res.json({ boardName, employees });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
