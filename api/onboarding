// =============================================================
// api/webhook.js — TOUT-EN-UN (1 seul fichier, 1 seule URL)
//
// URL principale (webhook monday, POST) :
//   https://ton-projet.vercel.app/api/webhook
//
// Outils de debug (GET, via ?action=...) :
//   /api/webhook?action=setup-webhook
//   /api/webhook?action=check-formation-index
//   /api/webhook?action=test-reservation&itemId=XXXXX
// =============================================================

const MONDAY_API_URL = "https://api.monday.com/v2";

// ─── CONSTANTES (variables d'environnement Vercel) ───────────

const BOARD_ID_1 = process.env.BOARD_ID_1;
const BOARD_ID_2 = process.env.BOARD_ID_2;
const BOARD_ID_3 = process.env.BOARD_ID_3; // board formation (original)
const RESERVATION_BOARD_ID = process.env.RESERVATION_BOARD_ID; // 5091270878
const MAPPING_BOARD_ID = process.env.MAPPING_BOARD_ID; // 5098181150
const FORMATION_ORIGINAL_BOARD_ID = BOARD_ID_3;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // ex: https://ton-projet.vercel.app/api/webhook

const FORMATION_STATUS_COLUMN_ID = "color_mm3h887b";
const FORMATION_DONE_INDEXES = [1]; // index du label "formé"

// Correspondance boardOriginalId → colonne People dans les boards dupliqués
const PEOPLE_COLUMN_IDS = {
  [BOARD_ID_1]: "multiple_person_mm3h87q4",
  [BOARD_ID_2]: "multiple_person_mm3h6emb",
  [BOARD_ID_3]: "multiple_person_mm3hm310"
};

// ─── HELPERS API MONDAY ───────────────────────────────────────

function getApiKey() {
  const key = process.env.MONDAY_API_KEY;
  if (!key) throw new Error("MONDAY_API_KEY manquant dans les variables d'environnement.");
  return key;
}

async function callMondayAPI(query) {
  const response = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": getApiKey(),
      "API-Version": "2026-04"
    },
    body: JSON.stringify({ query })
  });

  const code = response.status;
  const body = await response.text();

  if (code !== 200) {
    throw new Error(`HTTP ${code} — ${body}`);
  }

  return JSON.parse(body);
}

function escapeForGraphQL(str) {
  return String(str).replace(/"/g, '\\"');
}

function getBoardIds() {
  return [BOARD_ID_1, BOARD_ID_2, BOARD_ID_3].filter(Boolean);
}

// =============================================================
// ── LOGIQUE ONBOARDING (nouvel employé) ──────────────────────
// =============================================================

async function getUserIdFromCentralItem(itemId) {
  const query = `
    query {
      items(ids: [${itemId}]) {
        column_values(ids: ["person"]) {
          ... on PeopleValue {
            persons_and_teams {
              id
              kind
            }
          }
        }
      }
    }
  `;

  const result = await callMondayAPI(query);
  if (result.errors) throw new Error("getUserIdFromCentralItem échoué : " + JSON.stringify(result.errors));

  const colValues = result.data.items[0]?.column_values || [];
  if (colValues.length === 0) return null;

  const persons = colValues[0]?.persons_and_teams || [];
  const person = persons.find(p => p.kind === "person");
  return person ? person.id : null;
}

async function createWorkspace(name) {
  const safeName = escapeForGraphQL(name);
  const mutation = `
    mutation {
      create_workspace(
        name: "${safeName}",
        kind: open,
        description: "Workspace créé automatiquement via webhook"
      ) {
        id
        name
      }
    }
  `;
  const result = await callMondayAPI(mutation);
  if (result.errors) throw new Error("create_workspace échoué : " + JSON.stringify(result.errors));
  return result.data.create_workspace.id;
}

async function addUserToWorkspace(userId, workspaceId) {
  const mutation = `
    mutation {
      add_users_to_workspace(
        workspace_id: ${workspaceId},
        user_ids: [${userId}],
        kind: subscriber
      ) {
        id
        name
      }
    }
  `;
  const result = await callMondayAPI(mutation);
  if (result.errors) throw new Error("add_users_to_workspace échoué : " + JSON.stringify(result.errors));
  return result.data.add_users_to_workspace;
}

async function duplicateBoard(boardId, workspaceId) {
  const nameQuery = `
    query {
      boards(ids: [${boardId}]) {
        name
      }
    }
  `;
  const nameResult = await callMondayAPI(nameQuery);
  if (nameResult.errors) {
    throw new Error(`Récupération nom board ${boardId} échouée : ` + JSON.stringify(nameResult.errors));
  }
  const originalName = nameResult.data.boards[0].name;
  const safeName = escapeForGraphQL(originalName);

  const mutation = `
    mutation {
      duplicate_board(
        board_id: ${boardId},
        duplicate_type: duplicate_board_with_pulses_and_updates,
        workspace_id: ${workspaceId},
        board_name: "${safeName}"
      ) {
        board {
          id
          name
        }
      }
    }
  `;
  const result = await callMondayAPI(mutation);
  if (result.errors) {
    throw new Error(`duplicate_board ${boardId} échoué : ` + JSON.stringify(result.errors));
  }

  return result.data.duplicate_board.board.id;
}

async function saveBoardMapping(originalBoardId, duplicatedBoardId, workspaceId, workspaceName, userId, boardDupliqueName) {
  const columnValues = {
    text_mm45h7m7: String(duplicatedBoardId),
    text_mm459ktr: String(workspaceId),
    text_mm454sax: String(workspaceName),
    text_mm455dn5: String(userId),
    text_mm48mx70: String(boardDupliqueName || "")
  };

  const mutation = `
    mutation {
      create_item(
        board_id: ${MAPPING_BOARD_ID},
        item_name: "${escapeForGraphQL(String(originalBoardId))}",
        column_values: "${escapeForGraphQL(JSON.stringify(columnValues))}"
      ) { id }
    }
  `;
  const result = await callMondayAPI(mutation);
  if (result.errors) throw new Error("saveBoardMapping échoué : " + JSON.stringify(result.errors));
  return result.data.create_item;
}

async function setPeopleColumn(boardId, originalBoardId, userId) {
  const peopleColumnId = PEOPLE_COLUMN_IDS[originalBoardId];
  if (!peopleColumnId) return;

  const query = `
    query {
      boards(ids: [${boardId}]) {
        items_page(limit: 500) {
          items {
            id
          }
        }
      }
    }
  `;

  const result = await callMondayAPI(query);
  if (result.errors) throw new Error("setPeopleColumn query échouée : " + JSON.stringify(result.errors));

  const items = result.data.boards[0]?.items_page?.items || [];
  if (items.length === 0) return;

  const colValues = {};
  colValues[peopleColumnId] = { personsAndTeams: [{ id: userId, kind: "person" }] };
  const columnValuesStr = escapeForGraphQL(JSON.stringify(colValues));

  for (const item of items) {
    const mutation = `
      mutation {
        change_multiple_column_values(
          item_id: ${item.id},
          board_id: ${boardId},
          column_values: "${columnValuesStr}"
        ) {
          id
        }
      }
    `;
    const mutResult = await callMondayAPI(mutation);
    if (mutResult.errors) {
      console.error(`setPeopleColumn item ${item.id} échoué :`, JSON.stringify(mutResult.errors));
    }
  }
}

async function processOneBoard(origBoardId, workspaceId, workspaceName, userId) {
  const newBoardId = await duplicateBoard(origBoardId, workspaceId);
  await saveBoardMapping(origBoardId, newBoardId, workspaceId, workspaceName, userId);
  await setPeopleColumn(newBoardId, origBoardId, userId);
  return { origBoardId, newBoardId };
}

/**
 * Traite l'arrivée d'un nouvel employé :
 * 1. Crée le workspace
 * 2. Duplique les 3 boards EN PARALLÈLE (Promise.all — pas de sleep bloquant)
 * 3. Ajoute l'utilisateur au workspace
 */
async function processOnboarding(itemId, itemName) {
  const userId = await getUserIdFromCentralItem(itemId);
  if (!userId) {
    return { status: "ignored", reason: "no_person_column" };
  }

  const workspaceName = itemName;
  const workspaceId = await createWorkspace(workspaceName);

  const boardIds = getBoardIds();

  const results = await Promise.all(
    boardIds.map(origBoardId =>
      processOneBoard(origBoardId, workspaceId, workspaceName, userId)
    )
  );

  await addUserToWorkspace(userId, workspaceId);

  return { status: "ok", workspaceId, userId, boards: results };
}

// =============================================================
// ── LOGIQUE RÉSERVATION (vérification formation) ─────────────
// =============================================================

async function getReservationData(itemId) {
  const query = `
    query {
      items(ids: [${itemId}]) {
        column_values(ids: ["status", "person"]) {
          id
          ... on StatusValue {
            label
          }
          ... on PeopleValue {
            persons_and_teams {
              id
              kind
            }
          }
        }
      }
    }
  `;

  const result = await callMondayAPI(query);
  if (result.errors) throw new Error("getReservationData échoué : " + JSON.stringify(result.errors));

  const colValues = result.data.items[0]?.column_values || [];

  let equipementLabel = null;
  let userId = null;

  for (const col of colValues) {
    if (col.id === "status" && col.label) {
      equipementLabel = col.label;
    }
    if (col.id === "person" && col.persons_and_teams) {
      const person = col.persons_and_teams.find(p => p.kind === "person");
      if (person) userId = person.id;
    }
  }

  if (!equipementLabel || !userId) return null;
  return { equipementLabel, userId };
}

async function getFormationBoardId(userId) {
  const query = `
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
  `;

  const result = await callMondayAPI(query);
  if (result.errors) throw new Error("getFormationBoardId échoué : " + JSON.stringify(result.errors));

  const items = result.data.boards[0]?.items_page?.items || [];

  for (const item of items) {
    const originalBoardId = item.name; // le nom de l'item = originalBoardId
    if (originalBoardId !== FORMATION_ORIGINAL_BOARD_ID) continue;

    const dupBoardId = item.column_values.find(c => c.id === "text_mm45h7m7")?.text;
    const mappedUserId = item.column_values.find(c => c.id === "text_mm455dn5")?.text;

    if (String(mappedUserId) === String(userId) && dupBoardId) {
      return dupBoardId;
    }
  }

  return null;
}

async function verifierFormation(formationBoardId, equipementLabel) {
  const query = `
    query {
      boards(ids: [${formationBoardId}]) {
        items_page(limit: 500) {
          items {
            name
            column_values(ids: ["${FORMATION_STATUS_COLUMN_ID}"]) {
              ... on StatusValue {
                index
                label
              }
            }
          }
        }
      }
    }
  `;

  const result = await callMondayAPI(query);
  if (result.errors) throw new Error("verifierFormation échoué : " + JSON.stringify(result.errors));

  const items = result.data.boards[0]?.items_page?.items || [];

  const equipementNormalized = equipementLabel.trim().toLowerCase();
  const itemFormation = items.find(
    item => item.name.trim().toLowerCase() === equipementNormalized
  );

  if (!itemFormation) {
    return false;
  }

  const statusCol = itemFormation.column_values[0];
  if (!statusCol) return false;

  return FORMATION_DONE_INDEXES.includes(statusCol.index);
}

async function sendNotification(userId, itemId, message) {
  const safeMessage = escapeForGraphQL(message);
  const mutation = `
    mutation {
      create_notification(
        user_id: ${userId},
        target_id: ${itemId},
        text: "${safeMessage}",
        target_type: Project
      ) {
        text
      }
    }
  `;

  const result = await callMondayAPI(mutation);
  if (result.errors) throw new Error("sendNotification échoué : " + JSON.stringify(result.errors));
  return result.data.create_notification;
}

/**
 * 1. Lit l'équipement réservé + l'userId
 * 2. Trouve le board de formation dupliqué de cet employé
 * 3. Vérifie le statut de formation
 * 4. Notifie si non formé
 */
async function processReservation(itemId) {
  const reservationData = await getReservationData(itemId);
  if (!reservationData) {
    return { status: "ignored", reason: "missing_reservation_data" };
  }

  const { equipementLabel, userId } = reservationData;

  const formationBoardId = await getFormationBoardId(userId);
  if (!formationBoardId) {
    return { status: "ignored", reason: "no_formation_board" };
  }

  const estForme = await verifierFormation(formationBoardId, equipementLabel);

  if (!estForme) {
    const message = `⚠️ Tu as réservé "${equipementLabel}" mais tu n'as pas encore reçu la formation pour cet équipement. Contacte ton responsable pour planifier ta formation.`;
    await sendNotification(userId, itemId, message);
    return { status: "notification_sent", userId, equipementLabel };
  }

  return { status: "ok", formed: true, equipementLabel };
}

// =============================================================
// ── OUTILS DE DEBUG (déclenchés via ?action=...) ─────────────
// =============================================================

/**
 * action=setup-webhook
 * Crée le webhook sur le board de réservations (idempotent).
 */
async function actionSetupWebhook() {
  if (!WEBHOOK_URL) {
    return { status: "error", message: "Variable d'environnement WEBHOOK_URL manquante." };
  }

  const checkResult = await callMondayAPI(`
    query {
      webhooks(board_id: ${RESERVATION_BOARD_ID}) {
        id
        event
        config
      }
    }
  `);
  const existing = checkResult.data?.webhooks || [];
  const alreadyExists = existing.some(wh => wh.event === "create_pulse");

  if (alreadyExists) {
    return { status: "already_exists", webhooks: existing };
  }

  const result = await callMondayAPI(`
    mutation {
      create_webhook(
        board_id: ${RESERVATION_BOARD_ID},
        url: "${WEBHOOK_URL}",
        event: create_pulse
      ) {
        id
        board_id
      }
    }
  `);
  if (result.errors) throw new Error("create_webhook échoué : " + JSON.stringify(result.errors));

  return { status: "created", webhook: result.data.create_webhook };
}

/**
 * action=check-formation-index
 * Affiche les labels/index de la colonne statut du board de formation original.
 */
async function actionCheckFormationIndex() {
  const result = await callMondayAPI(`
    query {
      boards(ids: [${FORMATION_ORIGINAL_BOARD_ID}]) {
        columns(ids: ["${FORMATION_STATUS_COLUMN_ID}"]) {
          id
          title
          settings_str
        }
      }
    }
  `);
  const settings = result.data?.boards[0]?.columns[0]?.settings_str;

  return {
    status: "ok",
    settings_str: settings,
    parsed: settings ? JSON.parse(settings) : null
  };
}

/**
 * action=test-reservation&itemId=XXXXX
 * Lance processReservation() directement, sans passer par un vrai webhook monday.
 */
async function actionTestReservation(itemId) {
  if (!itemId) {
    return { status: "error", message: "Paramètre 'itemId' manquant. Usage : ?action=test-reservation&itemId=XXXXX" };
  }
  return processReservation(itemId);
}

// =============================================================
// ── HANDLER PRINCIPAL (routeur) ───────────────────────────────
// =============================================================

export default async function handler(req, res) {
  try {
    // ── Outils de debug en GET via ?action=... ────────────────
    if (req.method === "GET" && req.query.action) {
      const { action, itemId } = req.query;

      let result;
      switch (action) {
        case "setup-webhook":
          result = await actionSetupWebhook();
          break;
        case "check-formation-index":
          result = await actionCheckFormationIndex();
          break;
        case "test-reservation":
          result = await actionTestReservation(itemId);
          break;
        default:
          result = { status: "error", message: `Action inconnue : "${action}"` };
      }

      return res.status(200).json(result);
    }

    // ── Webhook monday (POST) ──────────────────────────────────
    if (req.method !== "POST") {
      return res.status(405).json({ status: "error", message: "Method not allowed" });
    }

    const payload = req.body;
    console.log("Payload reçu :", JSON.stringify(payload));

    // Handshake monday (vérification du webhook à la création)
    if (payload.challenge) {
      return res.status(200).json({ challenge: payload.challenge });
    }

    const event = payload.event;
    if (!event) {
      return res.status(200).json({ status: "ignored", reason: "no_event" });
    }

    // ── Trigger 2 : Nouvelle réservation ──────────────────────
    if (event.boardId && String(event.boardId) === String(RESERVATION_BOARD_ID)) {
      const itemId = event.pulseId;
      console.log(`Réservation détectée → itemId: ${itemId}`);

      const result = await processReservation(itemId);
      console.log("Résultat réservation :", JSON.stringify(result));

      return res.status(200).json(result);
    }

    // ── Trigger 1 : Nouvel employé ────────────────────────────
    if (event.type !== "create_pulse") {
      return res.status(200).json({ status: "ignored", reason: "not_create_pulse" });
    }

    const itemId = event.pulseId;
    const itemName = event.pulseName;

    console.log(`Nouveau compte reçu → itemId: ${itemId}, nom: "${itemName}"`);

    const result = await processOnboarding(itemId, itemName);
    console.log("Résultat onboarding :", JSON.stringify(result));

    return res.status(200).json(result);

  } catch (err) {
    console.error("ERREUR webhook :", err.message, err.stack);
    return res.status(200).json({ status: "error", message: err.message });
  }
}

export const config = {
  api: {
    bodyParser: true
  }
};
