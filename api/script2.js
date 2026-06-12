const fetch = require('node-fetch');

const MONDAY_API_URL = 'https://api.monday.com/v2';
const CENTRAL_BOARD_ID = '5096867375';
const MAPPING_BOARD_ID = '5098181150';

const CENTRAL_STATUS_COLUMNS = {
  '5094371533': 'color_mm45nvp2',
  '5094433469': 'color_mm457cxh',
  '5094429442': 'color_mm45wqqv'
};

const STATUS_COLUMN_IDS = {
  '5094371533': 'color_mm3hp2dg',
  '5094433469': 'color_mm3hjpm',
  '5094429442': 'color_mm3h887b'
};

async function callMondayAPI(query) {
  const response = await fetch(MONDAY_API_URL, {
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

async function getDuplicatedBoardIds(originalBoardId) {
  const result = await callMondayAPI(`
    query {
      boards(ids: [${MAPPING_BOARD_ID}]) {
        items_page(limit: 500) {
          items {
            name
            column_values { id text }
          }
        }
      }
    }
  `);
  const items = result.data?.boards[0]?.items_page?.items || [];
  return items
    .filter(item => String(item.name) === String(originalBoardId))
    .map(item => item.column_values.find(c => c.id === 'text_mm45h7m7')?.text)
    .filter(Boolean);
}

async function getOriginalBoardIdFromDuplicated(duplicatedBoardId) {
  const result = await callMondayAPI(`
    query {
      boards(ids: [${MAPPING_BOARD_ID}]) {
        items_page(limit: 500) {
          items {
            name
            column_values { id text }
          }
        }
      }
    }
  `);
  const items = result.data?.boards[0]?.items_page?.items || [];
  for (const item of items) {
    const dupId = item.column_values.find(c => c.id === 'text_mm45h7m7')?.text;
    if (String(dupId) === String(duplicatedBoardId)) return item.name;
  }
  return null;
}

async function getUserIdFromMapping(duplicatedBoardId) {
  const result = await callMondayAPI(`
    query {
      boards(ids: [${MAPPING_BOARD_ID}]) {
        items_page(limit: 500) {
          items {
            column_values { id text }
          }
        }
      }
    }
  `);
  const items = result.data?.boards[0]?.items_page?.items || [];
  for (const item of items) {
    const dupId = item.column_values.find(c => c.id === 'text_mm45h7m7')?.text;
    if (String(dupId) === String(duplicatedBoardId)) {
      return item.column_values.find(c => c.id === 'text_mm455dn5')?.text;
    }
  }
  return null;
}

async function getCentralItemIdByUserId(userId) {
  const result = await callMondayAPI(`
    query {
      boards(ids: [${CENTRAL_BOARD_ID}]) {
        items_page(limit: 500) {
          items {
            id
            column_values(ids: ["person"]) {
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
  for (const item of items) {
    for (const col of item.column_values) {
      if (col.persons_and_teams?.length > 0) {
        const person = col.persons_and_teams.find(p => p.kind === 'person');
        if (person && String(person.id) === String(userId)) return item.id;
      }
    }
  }
  return null;
}

async function getItemData(itemId) {
  const result = await callMondayAPI(`
    query {
      items(ids: [${itemId}]) {
        name
        column_values {
          id type
          ... on LinkValue { url url_text }
        }
      }
    }
  `);
  const item = result.data?.items[0];
  if (!item) return null;
  const linkCol = item.column_values.find(col => col.type === 'link' && col.url);
  return { name: item.name, linkCol: linkCol || null };
}

async function syncItemToDuplicatedBoards(event, originalBoardId) {
  const itemData = await getItemData(event.pulseId);
  if (!itemData) return;

  const dupBoardIds = await getDuplicatedBoardIds(originalBoardId);
  await Promise.all(dupBoardIds.map(async dupBoardId => {
    const colValues = {};
    if (itemData.linkCol?.url) {
      colValues[itemData.linkCol.id] = { url: itemData.linkCol.url, text: itemData.linkCol.url_text || '' };
    }
    const columnValuesStr = JSON.stringify(JSON.stringify(colValues));
    await callMondayAPI(`
      mutation {
        create_item(
          board_id: ${dupBoardId},
          item_name: "${itemData.name.replace(/"/g, '\\"')}",
          column_values: ${columnValuesStr}
        ) { id }
      }
    `);
  }));
}

async function syncLinkToDuplicatedBoards(event, originalBoardId) {
  const itemData = await getItemData(event.pulseId);
  if (!itemData?.linkCol?.url) return;

  const dupBoardIds = await getDuplicatedBoardIds(originalBoardId);
  await Promise.all(dupBoardIds.map(async dupBoardId => {
    const searchResult = await callMondayAPI(`
      query {
        boards(ids: [${dupBoardId}]) {
          items_page(limit: 500) {
            items { id name }
          }
        }
      }
    `);
    const items = searchResult.data?.boards[0]?.items_page?.items || [];
    const match = items.find(i => i.name === itemData.name);
    if (!match) return;

    const colValues = { [itemData.linkCol.id]: { url: itemData.linkCol.url, text: itemData.linkCol.url_text || '' } };
    await callMondayAPI(`
      mutation {
        change_multiple_column_values(
          item_id: ${match.id},
          board_id: ${dupBoardId},
          column_values: "${JSON.stringify(colValues).replace(/"/g, '\\"')}"
        ) { id }
      }
    `);
  }));
}

async function syncDeleteToDuplicatedBoards(event, originalBoardId) {
  const itemName = event.pulseName || event.itemName;
  const dupBoardIds = await getDuplicatedBoardIds(originalBoardId);

  await Promise.all(dupBoardIds.map(async dupBoardId => {
    const searchResult = await callMondayAPI(`
      query {
        boards(ids: [${dupBoardId}]) {
          items_page(limit: 500) {
            items { id name }
          }
        }
      }
    `);
    const items = searchResult.data?.boards[0]?.items_page?.items || [];
    const match = items.find(i => i.name === itemName);
    if (!match) return;

    await callMondayAPI(`mutation { delete_item(item_id: ${match.id}) { id } }`);
  }));
}

async function updateCentralBoardStatus(originalBoardId, duplicatedBoardId) {
  const statusColId = STATUS_COLUMN_IDS[originalBoardId];
  const result = await callMondayAPI(`
    query {
      boards(ids: [${duplicatedBoardId}]) {
        items_page(limit: 500) {
          items {
            column_values(ids: ["${statusColId}"]) {
              type
              ... on StatusValue { label }
            }
          }
        }
      }
    }
  `);

  const items = result.data?.boards[0]?.items_page?.items || [];
  if (!items.length) return;

  let forme = 0, enCours = 0, nonCommence = 0;
  for (const item of items) {
    for (const col of item.column_values) {
      const label = (col.label || '').toLowerCase().trim();
      if (label === 'formé') forme++;
      else if (label === 'en cours') enCours++;
      else nonCommence++;
    }
  }

  const total = forme + enCours + nonCommence;
  const pctForme = total > 0 ? forme / total : 0;
  let statusIndex;
  if (forme === total) statusIndex = 1;
  else if (pctForme >= 0.7) statusIndex = 2;
  else if (enCours > 0 || forme > 0) statusIndex = 0;
  else statusIndex = 5;

  const userId = await getUserIdFromMapping(duplicatedBoardId);
  if (!userId) return;

  const centralItemId = await getCentralItemIdByUserId(userId);
  if (!centralItemId) return;

  const centralColId = CENTRAL_STATUS_COLUMNS[originalBoardId];
  await callMondayAPI(`
    mutation {
      change_multiple_column_values(
        item_id: ${centralItemId},
        board_id: ${CENTRAL_BOARD_ID},
        column_values: "${JSON.stringify({ [centralColId]: { index: statusIndex } }).replace(/"/g, '\\"')}"
      ) { id }
    }
  `);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // ✅ GET → health check
  if (req.method === 'GET') {
    return res.json({ status: 'ok', message: 'Sync endpoint active' });
  }

  try {
    const payload = req.body;

    // Handshake Monday
    if (payload.challenge) {
      return res.json({ challenge: payload.challenge });
    }

    const event = payload.event;
    if (!event) return res.json({ status: 'ignored', reason: 'no_event' });

    const boardId = String(event.boardId);
    const originalBoardIds = [
      process.env.BOARD_ID_1,
      process.env.BOARD_ID_2,
      process.env.BOARD_ID_3
    ].filter(Boolean);

    // CAS 1 : board original
    if (originalBoardIds.includes(boardId)) {
      if (event.type === 'create_pulse' || event.type === 'create_item') {
        await syncItemToDuplicatedBoards(event, boardId);
        return res.json({ status: 'ok', action: 'sync_create' });
      }
      if (event.type === 'change_column_value' || event.type === 'change_specific_column_value') {
        await syncLinkToDuplicatedBoards(event, boardId);
        return res.json({ status: 'ok', action: 'sync_link' });
      }
      if (event.type === 'delete_pulse' || event.type === 'delete_item') {
        await syncDeleteToDuplicatedBoards(event, boardId);
        return res.json({ status: 'ok', action: 'sync_delete' });
      }
    }

    // CAS 2 : board dupliqué → statut central
    if (event.type === 'change_column_value' || event.type === 'change_specific_column_value') {
      const originalBoardId = await getOriginalBoardIdFromDuplicated(boardId);
      if (originalBoardId) {
        await updateCentralBoardStatus(originalBoardId, boardId);
        return res.json({ status: 'ok', action: 'update_central_status' });
      }
    }

    return res.json({ status: 'ignored', reason: 'unhandled_event_type' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
