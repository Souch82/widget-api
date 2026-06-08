import mapping from "../mapping.json" assert { type: "json" };

const MONDAY_API_URL = "https://api.monday.com/v2";

const BOARD_NAMES = {
  "5094371533": "MOP",
  "5094433469": "Procédures",
  "5094429442": "Formation Equipement",
};

const STATUS_COLUMN_IDS = {
  "5094371533": "color_mm3hp2dg",
  "5094433469": "color_mm3hjpm",
  "5094429442": "color_mm3h887b",
};

export default async function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");

    const boardName = req.query.board || "MOP";
    const data = await getProgressData(boardName);

    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function getProgressData(boardName) {
  const originalBoardId = Object.keys(BOARD_NAMES).find(
    id => BOARD_NAMES[id] === boardName
  );

  if (!originalBoardId) {
    return { boardName, employees: [] };
  }

  const duplicatedBoards = mapping
    .filter(row => String(row.originalBoardId) === String(originalBoardId))
    .map(row => ({
      boardId: String(row.duplicatedBoardId),
      userId: String(row.userId),
      statusColumnId: STATUS_COLUMN_IDS[originalBoardId],
    }));

  const centralEmployees = await getEmployeesFromCentralBoard();

  const employees = [];

  for (const emp of centralEmployees) {
    const board = duplicatedBoards.find(b => String(b.userId) === String(emp.id));

    if (!board) {
      employees.push({
        name: emp.name,
        photo: emp.photo,
        forme: 0,
        enCours: 0,
        nonCommence: 0,
        total: 0,
      });
      continue;
    }

    const stats = await getEmployeeProgress(board);
    employees.push({ name: emp.name, photo: emp.photo, ...stats });
  }

  return { boardName, employees };
}

async function getEmployeesFromCentralBoard() {
  const centralBoardId = process.env.CENTRAL_BOARD_ID;

  const query = `
    query {
      boards(ids: [${centralBoardId}]) {
        items_page(limit: 500) {
          items {
            id
            name
            column_values {
              ... on PeopleValue {
                persons_and_teams {
                  id
                  kind
                }
              }
            }
          }
        }
      }
    }
  `;

  const result = await callMondayAPI(query);
  const items = result.data.boards[0]?.items_page?.items || [];

  const employees = [];

  for (const item of items) {
    let userId = null;

    for (const col of item.column_values) {
      if (col.persons_and_teams?.length > 0) {
        const person = col.persons_and_teams.find(p => p.kind === "person");
        if (person) {
          userId = person.id;
          break;
        }
      }
    }

    const userInfo = userId
      ? await getUserInfo(userId)
      : { name: item.name, photo: null };

    employees.push({
      id: userId,
      name: userInfo.name || item.name,
      photo: userInfo.photo,
    });
  }

  return employees;
}

async function getEmployeeProgress(board) {
  const query = `
    query {
      boards(ids: [${board.boardId}]) {
        items_page(limit: 500) {
          items {
            column_values(ids: ["${board.statusColumnId}"]) {
              type
              ... on StatusValue {
                label
              }
            }
          }
        }
      }
    }
  `;

  const result = await callMondayAPI(query);
  const items = result.data.boards[0]?.items_page?.items || [];

  let forme = 0;
  let enCours = 0;
  let nonCommence = 0;

  for (const item of items) {
    for (const col of item.column_values) {
      const label = (col.label || "").toLowerCase().trim();

      if (label === "formé") forme++;
      else if (label === "en cours") enCours++;
      else nonCommence++;
    }
  }

  return {
    forme,
    enCours,
    nonCommence,
    total: forme + enCours + nonCommence,
  };
}

async function getUserInfo(userId) {
  const query = `
    query {
      users(ids: [${userId}]) {
        name
        photo_thumb_small
      }
    }
  `;

  const result = await callMondayAPI(query);
  const user = result.data.users?.[0];

  return {
    name: user?.name || null,
    photo: user?.photo_thumb_small || null,
  };
}

async function callMondayAPI(query) {
  const response = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: process.env.MONDAY_API_KEY,
      "API-Version": "2025-04",
    },
    body: JSON.stringify({ query }),
  });

  const result = await response.json();

  if (!response.ok || result.errors) {
    throw new Error(JSON.stringify(result.errors || result));
  }

  return result;
}
