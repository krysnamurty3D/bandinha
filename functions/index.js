const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");

const COORDENADOR_EMAIL = "krysnamurty@gmail.com";

initializeApp();
const db = getFirestore();

async function sendToAll(title, body) {
  const tokensSnap = await db.collection("pushTokens").get();
  if (tokensSnap.empty) return;
  const tokens = tokensSnap.docs.map(d => d.id);
  const res = await getMessaging().sendEachForMulticast({
    tokens,
    notification: { title, body }
  });
  const invalidos = [];
  res.responses.forEach((r, i) => {
    if (!r.success && ["messaging/registration-token-not-registered", "messaging/invalid-registration-token"].includes(r.error?.code)) {
      invalidos.push(tokens[i]);
    }
  });
  await Promise.all(invalidos.map(t => db.collection("pushTokens").doc(t).delete()));
}

exports.onNovaAgenda = onDocumentCreated("agenda/{id}", async event => {
  const a = event.data.data();
  const titulo = a.titulo || "Novo dia marcado";
  await sendToAll("Nova data na Agenda", `${titulo} — ${a.data?.split("-").reverse().join("/") || ""}`);
});

exports.onNovoRoteiro = onDocumentCreated("roteiros/{id}", async event => {
  const r = event.data.data();
  await sendToAll("Novo roteiro criado", r.titulo || "Roteiro do próximo encontro");
});

exports.onNovaMusica = onDocumentCreated("musicas/{id}", async event => {
  const m = event.data.data();
  await sendToAll("Nova música adicionada", m.nome || "");
});

exports.enviarAvisoAoVivo = onCall(async request => {
  if (request.auth?.token?.email !== COORDENADOR_EMAIL) {
    throw new HttpsError("permission-denied", "Apenas o coordenador pode enviar avisos ao vivo.");
  }
  const { local, minutos } = request.data || {};
  if (!local || typeof minutos !== "number" || minutos < 0) {
    throw new HttpsError("invalid-argument", "Informe o local e os minutos.");
  }
  const texto = minutos === 0
    ? `Posicionem-se agora em ${local}`
    : `Faltam ${minutos} min — posicionem-se em ${local}`;
  await sendToAll("Aviso ao vivo", texto);
  return { ok: true };
});

const LIMIARES = [
  { chave: "24h", minutos: 24 * 60 },
  { chave: "3h", minutos: 3 * 60 },
  { chave: "30min", minutos: 30 }
];

exports.lembretesAgenda = onSchedule("every 15 minutes", async () => {
  const agora = Date.now();
  const snap = await db.collection("agenda").get();
  for (const docSnap of snap.docs) {
    const a = docSnap.data();
    if (!a.data || !a.hora) continue;
    const evento = new Date(`${a.data}T${a.hora}:00`).getTime();
    const diffMin = (evento - agora) / 60000;
    const enviados = a.lembretesEnviados || [];
    for (const limiar of LIMIARES) {
      if (diffMin <= limiar.minutos && diffMin > limiar.minutos - 15 && !enviados.includes(limiar.chave)) {
        const faltaTexto = limiar.chave === "24h" ? "amanhã" : limiar.chave === "3h" ? "em 3 horas" : "em 30 minutos";
        await sendToAll("Lembrete", `${a.titulo || "Evento"} começa ${faltaTexto} (${a.hora})`);
        await docSnap.ref.update({ lembretesEnviados: [...enviados, limiar.chave] });
      }
    }
  }
});
