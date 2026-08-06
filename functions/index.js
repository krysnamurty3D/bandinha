// Cloud Functions for Bandinha push notifications (auto-deploy, retry 6)
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { getMessaging } = require("firebase-admin/messaging");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { FieldValue } = require("firebase-admin/firestore");

const COORDENADOR_EMAIL = "krysnamurty@gmail.com";

initializeApp();
const db = getFirestore();

async function sendToAll(title, body, url) {
  const tokensSnap = await db.collection("pushTokens").get();
  if (tokensSnap.empty) return;
  const tokens = tokensSnap.docs.map(d => d.id);
  const res = await getMessaging().sendEachForMulticast({
    tokens,
    data: { title, body, url: url || "publico.html" }
  });
  const invalidos = [];
  res.responses.forEach((r, i) => {
    if (!r.success && ["messaging/registration-token-not-registered", "messaging/invalid-registration-token"].includes(r.error?.code)) {
      invalidos.push(tokens[i]);
    }
  });
  await Promise.all(invalidos.map(t => db.collection("pushTokens").doc(t).delete()));
}

const HISTORICO_LIMITE = 15;

async function registrarHistorico(tipo, texto) {
  await db.collection("avisosHistorico").add({ tipo, texto, disparadoEm: Date.now() });
  const snap = await db.collection("avisosHistorico").orderBy("disparadoEm", "desc").offset(HISTORICO_LIMITE).get();
  await Promise.all(snap.docs.map(d => d.ref.delete()));
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
  const { proximaEtapa, minutos, urgente, avisoAntesMin, mensagemCustom } = request.data || {};
  if (mensagemCustom) {
    const textoLimpo = String(mensagemCustom).trim();
    if (!textoLimpo) {
      throw new HttpsError("invalid-argument", "Escreva o texto do aviso.");
    }
    await db.collection("aoVivo").doc("atual").set({
      proximaEtapa: textoLimpo,
      minutos: 0,
      disparadoEm: Date.now(),
      urgente: false,
      custom: true,
      avisoAntesMin: avisoAntesMin === 10 ? 10 : 5,
      avisoAntesEnviado: true
    });
    await sendToAll("Aviso", textoLimpo, "publico.html?tab=aovivo");
    await registrarHistorico("custom", textoLimpo);
    return { ok: true };
  }
  if (!proximaEtapa || typeof minutos !== "number" || minutos < 0) {
    throw new HttpsError("invalid-argument", "Informe a próxima etapa e os minutos.");
  }
  const texto = urgente
    ? `🚨 Urgente — corram para ${proximaEtapa} agora!`
    : minutos === 0
      ? `Posicionem-se agora em ${proximaEtapa}`
      : `Em ${minutos} min: ${proximaEtapa}`;
  await db.collection("aoVivo").doc("atual").set({
    proximaEtapa,
    minutos,
    disparadoEm: Date.now(),
    urgente: !!urgente,
    avisoAntesMin: avisoAntesMin === 10 ? 10 : 5,
    avisoAntesEnviado: false
  });
  await sendToAll(urgente ? "🚨 Urgente" : "Aviso ao vivo", texto, "publico.html?tab=aovivo");
  await registrarHistorico(urgente ? "urgente" : "normal", texto);
  return { ok: true };
});

exports.avisoAntesFim = onSchedule("* * * * *", async () => {
  const ref = db.collection("aoVivo").doc("atual");
  const snap = await ref.get();
  if (!snap.exists) return;
  const a = snap.data();
  if (a.urgente || !a.minutos || a.avisoAntesEnviado) return;
  const limiar = a.avisoAntesMin || 5;
  const restanteMin = (a.disparadoEm + a.minutos * 60000 - Date.now()) / 60000;
  if (restanteMin <= limiar && restanteMin > limiar - 1) {
    await sendToAll("Atenção", `Faltam ${limiar} minutos — próxima etapa: ${a.proximaEtapa}`, "publico.html?tab=aovivo");
    await ref.update({ avisoAntesEnviado: true });
  }
});

const LIMIARES = [
  { chave: "24h", minutos: 24 * 60 },
  { chave: "3h", minutos: 3 * 60 },
  { chave: "30min", minutos: 30 }
];

const NOVA_EXPIRACAO_DIAS = 14;

exports.expirarMusicasNovas = onSchedule("every 24 hours", async () => {
  const agora = Date.now();
  const limite = agora - NOVA_EXPIRACAO_DIAS * 24 * 60 * 60 * 1000;
  const snap = await db.collection("musicas").where("nova", "==", true).get();
  const semData = snap.docs.filter(d => !d.data().novaDesde);
  const expiradas = snap.docs.filter(d => d.data().novaDesde && d.data().novaDesde <= limite);
  await Promise.all([
    ...semData.map(d => d.ref.update({ novaDesde: agora })),
    ...expiradas.map(d => d.ref.update({ nova: false, novaDesde: FieldValue.delete() }))
  ]);
});

const EXT_POR_TIPO = {
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/aac": "aac"
};

async function baixarDoDrive(fileId) {
  let url = `https://drive.google.com/uc?export=download&id=${fileId}`;
  let res = await fetch(url);
  let contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    const html = await res.text();
    const match = html.match(/confirm=([0-9A-Za-z_]+)/);
    if (!match) throw new Error("Arquivo não acessível publicamente no Drive");
    url = `https://drive.google.com/uc?export=download&confirm=${match[1]}&id=${fileId}`;
    res = await fetch(url);
    contentType = res.headers.get("content-type") || "";
  }
  if (!res.ok) throw new Error(`Drive respondeu ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType: EXT_POR_TIPO[contentType] ? contentType : "audio/mpeg" };
}

exports.migrarAudiosDrive = onCall({ timeoutSeconds: 300 }, async request => {
  if (request.auth?.token?.email !== COORDENADOR_EMAIL) {
    throw new HttpsError("permission-denied", "Apenas o coordenador pode migrar áudios.");
  }
  const snap = await db.collection("musicas").get();
  const alvos = snap.docs.filter(d => d.data().audioId && !d.data().audioUrl);
  const bucket = getStorage().bucket();
  let migradas = 0;
  const falhas = [];
  for (const docSnap of alvos) {
    const m = docSnap.data();
    try {
      const { buffer, contentType } = await baixarDoDrive(m.audioId);
      const ext = EXT_POR_TIPO[contentType] || "mp3";
      const path = `audio/${docSnap.id}-${Date.now()}.${ext}`;
      const file = bucket.file(path);
      await file.save(buffer, { metadata: { contentType } });
      const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media`;
      await docSnap.ref.update({ audioUrl: url, audioId: FieldValue.delete() });
      migradas++;
    } catch (err) {
      falhas.push({ nome: m.nome || docSnap.id, erro: err.message });
    }
  }
  return { total: alvos.length, migradas, falhas };
});

exports.lembretesAgenda = onSchedule("every 15 minutes", async () => {
  const agora = Date.now();
  const snap = await db.collection("agenda").get();
  for (const docSnap of snap.docs) {
    const a = docSnap.data();
    if (!a.data || !a.hora) continue;
    const evento = new Date(`${a.data}T${a.hora}:00-03:00`).getTime();
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
