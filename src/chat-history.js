"use strict";

/* Każdy plik idzie do okna zwykłym <script>, więc dzieli JEDEN globalny
   zakres. Bez tej otoczki `const api` z drugiego pliku wywalał go w całości
   ("Identifier 'api' has already been declared") i modułu po prostu nie było
   w oknie — testy w Node przechodziły, bo tam każdy plik ma własny zakres. */
(function () {
  /**
   * Czysta logika historii czatu — bez DOM.
   * Otwarcie długiej sesji zerowało padding i gubiło lokalnie wysłaną bańkę.
   */

  function contentHeightWithoutPad(scrollHeight, paddingTop) {
    const h = Number(scrollHeight) || 0;
    const pad = Number(paddingTop) || 0;
    return Math.max(0, h - pad);
  }

  function nextChatPadding(available, contentH) {
    const gap = Math.floor((Number(available) || 0) - (Number(contentH) || 0));
    return gap > 1 ? gap : 0;
  }

  function msgText(m) {
    return String((m && (m.text || m.content)) || "").trim();
  }

  function isEmptyAssistant(m) {
    return (
      m &&
      m.role === "assistant" &&
      !msgText(m) &&
      !(m.tools && m.tools.length)
    );
  }

  function placeLocalUser(out, m) {
    const last = out[out.length - 1];
    const hasUser = out.some((x) => x && x.role === "user");
    // Missing first prompt of a brand-new turn: only an empty/streaming shell.
    if (!hasUser && last && last.role === "assistant" && isEmptyAssistant(last)) {
      out.splice(out.length - 1, 0, m);
      return;
    }
    if (!hasUser && last && last.role === "assistant" && last._streaming && !last.tools?.length) {
      out.splice(out.length - 1, 0, m);
      return;
    }
    // Follow-up: always after the last reply, never at the top of history.
    out.push(m);
  }

  /**
   * Ta sama treść nie ma prawa wejść drugi raz — nawet gdy bańka wciąż ma
   * flagę _streaming. Wcześniej `m._streaming ||` przepuszczało ją bezwarunkowo:
   * tura kończyła się, gdy user patrzył na inną kartę, flaga zostawała, a po
   * powrocie transkrypt Z DYSKU i ta sama żywa bańka malowały się OBIE.
   * Stąd dwie identyczne odpowiedzi Groka pod jednym pytaniem.
   * Prefiks liczy się jako duplikat: stream w połowie to początek tekstu,
   * który w transkrypcie jest już cały.
   */
  function mergeTranscriptWithLocals(mapped, current) {
    const base = Array.isArray(mapped) ? mapped.slice() : [];
    const extras = (current || []).filter((m) => m && (m._local || m._streaming));
    if (!extras.length) return base;
    const seenTexts = base.map(msgText).filter(Boolean);
    const out = base.slice();
    const duplikat = (t) =>
      Boolean(t) && seenTexts.some((b) => b === t || b.startsWith(t));
    for (const m of extras) {
      const t = msgText(m);
      if (duplikat(t)) continue;
      if (m.role === "user" && m._local) placeLocalUser(out, m);
      else out.push(m);
      if (t) seenTexts.push(t);
    }
    return out;
  }



  /**
   * Widok jednej sesji. Cudzy czat (dłuższy, bez _sid, inny _sid) nie wchodzi.
   * Przy przełączaniu A→B dawny merge brał dłuższą historię A i pokazywał
   * ją jako B — stąd ta sama odpowiedź w obu kartach.
   */
  function loadSessionView(liveMsgs, current, sid) {
    const live = Array.isArray(liveMsgs) ? liveMsgs.slice() : [];
    // Rekord sesji zawiera z definicji tylko WLASNE wiadomosci — nie ma juz
    // pola _sid do sprawdzania, bo nie ma jak wlozyc tu cudzej banki.
    const extras = (current || []).filter(
      (m) => m && (m._local || m._streaming)
    );
    if (!live.length) return extras.slice();
    return mergeTranscriptWithLocals(live, extras);
  }

  const api = {
    contentHeightWithoutPad,
    nextChatPadding,
    mergeTranscriptWithLocals,
    loadSessionView,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof window !== "undefined") {
    window.chatHistory = api;
  }
})();
