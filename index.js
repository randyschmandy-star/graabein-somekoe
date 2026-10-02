const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const META_ACCESS_TOKEN = defineSecret("META_ACCESS_TOKEN");
const FACEBOOK_PAGE_ID = defineSecret("FACEBOOK_PAGE_ID");
const INSTAGRAM_BUSINESS_ACCOUNT_ID = defineSecret("INSTAGRAM_BUSINESS_ACCOUNT_ID");

const GRAPH_API_VERSION = "v26.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

function vent(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function graphPost(sti, params) {
  const res = await fetch(`${GRAPH_BASE}/${sti}`, { method: "POST", body: new URLSearchParams(params) });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Graph-feil (${sti}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function graphGet(sti, params) {
  const url = `${GRAPH_BASE}/${sti}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Graph-feil (${sti}): ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Facebooks klassiske side-endepunkter (photos/videos/video_reels m.fl.)
 * godtar ikke systembrukerens eget token direkte – de krever et
 * side-spesifikt access-token, hentet ut via en egen utveksling.
 * (Instagrams Graph API er ikke like strengt og godtar systembruker-
 * tokenet direkte, så det trenger ingen utveksling.)
 */
async function hentSideToken(pageId, systemBrukerToken) {
  const data = await graphGet(pageId, { fields: "access_token", access_token: systemBrukerToken });
  return data.access_token;
}

// ---------------------------------------------------------------------------
// FACEBOOK
// ---------------------------------------------------------------------------

/** Innlegg i nyhetsstrømmen (bilde eller video). */
async function postTilFacebookInnlegg({ mediaUrl, mediaType, tekst, pageId, token }) {
  if (mediaType === "video") {
    const data = await graphPost(`${pageId}/videos`, {
      file_url: mediaUrl,
      description: tekst || "",
      access_token: token,
    });
    return data.id;
  }
  const data = await graphPost(`${pageId}/photos`, {
    url: mediaUrl,
    caption: tekst || "",
    access_token: token,
  });
  return data.post_id || data.id;
}

/** Story (bilde eller video). Facebook støtter ikke bildetekst på Story. */
async function postTilFacebookStory({ mediaUrl, mediaType, pageId, token }) {
  if (mediaType === "video") {
    const opprettet = await graphPost(`${pageId}/videos`, {
      file_url: mediaUrl,
      published: "false",
      access_token: token,
    });
    const videoId = opprettet.id;

    // Video må ferdigbehandles hos Meta før den kan publiseres som story.
    for (let forsok = 0; forsok < 20; forsok++) {
      const status = await graphGet(videoId, { fields: "status", access_token: token });
      const tilstand = status.status && status.status.video_status;
      if (tilstand === "ready") break;
      if (tilstand === "error") throw new Error(`Facebook kunne ikke behandle videoen: ${JSON.stringify(status)}`);
      await vent(3000);
    }

    const publisert = await graphPost(`${pageId}/video_stories`, { video_id: videoId, access_token: token });
    return publisert.post_id || publisert.id || videoId;
  }

  const opprettet = await graphPost(`${pageId}/photos`, {
    url: mediaUrl,
    published: "false",
    access_token: token,
  });
  const publisert = await graphPost(`${pageId}/photo_stories`, { photo_id: opprettet.id, access_token: token });
  return publisert.post_id || publisert.id || opprettet.id;
}

/** Reel (kun video). Bruker Metas "hosted URL"-opplastingsflyt for video_reels. */
async function postTilFacebookReel({ mediaUrl, tekst, pageId, token }) {
  const start = await graphPost(`${pageId}/video_reels`, {
    upload_phase: "start",
    access_token: token,
  });
  const videoId = start.video_id;

  // Be Meta hente videoen direkte fra vår hostede URL, i stedet for at vi
  // laster opp de rå bytene selv.
  const uploadRes = await fetch(start.upload_url, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${token}`,
      file_url: mediaUrl,
    },
  });
  const uploadData = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok) {
    throw new Error(`Facebook Reel-feil (opplasting): ${JSON.stringify(uploadData)}`);
  }

  // Vent til videoen er ferdig behandlet før publisering.
  for (let forsok = 0; forsok < 40; forsok++) {
    const status = await graphGet(videoId, { fields: "status", access_token: token });
    const tilstand = status.status && status.status.video_status;
    if (tilstand === "ready") break;
    if (tilstand === "error") throw new Error(`Facebook kunne ikke behandle reelen: ${JSON.stringify(status)}`);
    await vent(3000);
  }

  const ferdig = await graphPost(`${pageId}/video_reels`, {
    upload_phase: "finish",
    video_id: videoId,
    video_state: "PUBLISHED",
    description: tekst || "",
    access_token: token,
  });
  return ferdig.post_id || videoId;
}

/**
 * Karusell (flere bilder/videoer i ett innlegg). Facebooks klassiske
 * attached_media-mekanisme støtter foreløpig kun bilder – ikke video – i en
 * karusell, så vi feiler tydelig hvis noen av elementene er video i stedet
 * for å late som det gikk bra.
 */
async function postTilFacebookCarousel({ mediaItems, tekst, pageId, token }) {
  if (mediaItems.some((item) => item.type === "video")) {
    throw new Error(
      "Facebook-karuseller støtter foreløpig bare bilder, ikke video. " +
        "Fjern videoen fra karusellen, eller post den som eget innlegg/reel."
    );
  }

  // Last opp hvert bilde som upublisert først, så de kan limes sammen i ett
  // innlegg via attached_media.
  const fbids = [];
  for (const item of mediaItems) {
    const data = await graphPost(`${pageId}/photos`, {
      url: item.url,
      published: "false",
      access_token: token,
    });
    fbids.push(data.id);
  }

  const params = { message: tekst || "", access_token: token };
  fbids.forEach((id, i) => {
    params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id });
  });

  const data = await graphPost(`${pageId}/feed`, params);
  return data.id;
}

// ---------------------------------------------------------------------------
// INSTAGRAM
// ---------------------------------------------------------------------------

/**
 * Instagram samler innlegg, story og reel i samme to-stegs API
 * (opprett media-beholder, vent til den er klar, publiser).
 * Story støtter ikke bildetekst.
 */
async function postTilInstagram({ mediaUrl, mediaType, tekst, type, igUserId, token }) {
  const params = { access_token: token };

  if (type === "story") {
    params.media_type = "STORIES";
    if (mediaType === "video") params.video_url = mediaUrl;
    else params.image_url = mediaUrl;
  } else if (type === "reel") {
    params.media_type = "REELS";
    params.video_url = mediaUrl;
    params.caption = tekst || "";
  } else {
    // Vanlig innlegg
    if (mediaType === "video") {
      params.media_type = "VIDEO";
      params.video_url = mediaUrl;
    } else {
      params.image_url = mediaUrl;
    }
    params.caption = tekst || "";
  }

  const opprettet = await graphPost(`${igUserId}/media`, params);
  const containerId = opprettet.id;

  // Video (reel, video-story, video-innlegg) må behandles ferdig hos Meta
  // før den kan publiseres. Stillbilder er som regel klare med en gang,
  // men vi sjekker uansett for å være sikre.
  for (let forsok = 0; forsok < 40; forsok++) {
    const status = await graphGet(containerId, { fields: "status_code", access_token: token });
    if (status.status_code === "FINISHED") break;
    if (status.status_code === "ERROR") throw new Error(`Instagram kunne ikke behandle mediet: ${JSON.stringify(status)}`);
    await vent(3000);
  }

  const publisert = await graphPost(`${igUserId}/media_publish`, {
    creation_id: containerId,
    access_token: token,
  });
  return publisert.id;
}

/**
 * Karusell: flere bilder/videoer limt sammen i én container, publisert som
 * ett innlegg. Instagram støtter en fri miks av bilder og video i samme
 * karusell.
 */
async function postTilInstagramCarousel({ mediaItems, tekst, igUserId, token }) {
  // Opprett én container per element i karusellen.
  const childIds = [];
  for (const item of mediaItems) {
    const params = { is_carousel_item: "true", access_token: token };
    if (item.type === "video") params.video_url = item.url;
    else params.image_url = item.url;
    const opprettet = await graphPost(`${igUserId}/media`, params);
    childIds.push(opprettet.id);
  }

  // Vent til alle elementene (videoer tar tid) er ferdig behandlet.
  for (const childId of childIds) {
    for (let forsok = 0; forsok < 40; forsok++) {
      const status = await graphGet(childId, { fields: "status_code", access_token: token });
      if (status.status_code === "FINISHED") break;
      if (status.status_code === "ERROR") {
        throw new Error(`Instagram kunne ikke behandle et element i karusellen: ${JSON.stringify(status)}`);
      }
      await vent(3000);
    }
  }

  // Lim elementene sammen i en overordnet CAROUSEL-container og publiser.
  const parent = await graphPost(`${igUserId}/media`, {
    media_type: "CAROUSEL",
    children: childIds.join(","),
    caption: tekst || "",
    access_token: token,
  });

  const publisert = await graphPost(`${igUserId}/media_publish`, {
    creation_id: parent.id,
    access_token: token,
  });
  return publisert.id;
}

// ---------------------------------------------------------------------------

/**
 * Kjører hvert 10. minutt: finner godkjente innlegg som har nådd
 * planlagt tidspunkt (eller ikke har noe, dvs. "post så snart som mulig"),
 * og poster dem.
 *
 * Hvert dokument gjelder nå én kombinasjon av plattform OG type:
 *   plattform:  "facebook" | "instagram"
 *   type:       "feed" | "story" | "reel" | "carousel"
 *   mediaType:  "image" | "video"  (reel krever alltid video; gjelder ikke
 *               "carousel", som i stedet har et mediaItems-array, se under)
 *   mediaItems: [{ url, type: "image"|"video" }, ...] – kun for
 *               type === "carousel" (2–10 elementer). Vanlige innlegg
 *               bruker fortsatt mediaUrl/mediaType som før.
 *
 * Flere varianter av samme bilde/video (f.eks. "Facebook Innlegg" og
 * "Facebook Reel") er egne dokumenter med samme gruppeId, og postes/
 * feiler/slettes helt uavhengig av hverandre.
 */
exports.publiserGodkjenteInnlegg = onSchedule(
  {
    schedule: "every 10 minutes",
    secrets: [META_ACCESS_TOKEN, FACEBOOK_PAGE_ID, INSTAGRAM_BUSINESS_ACCOUNT_ID],
    region: "europe-west1",
    // Reels og video-story/-innlegg kan ta litt tid å behandle hos Meta
    // (vi poller status), så funksjonen får god tid på seg.
    timeoutSeconds: 540,
  },
  async () => {
    const now = admin.firestore.Timestamp.now();
    const systemBrukerToken = META_ACCESS_TOKEN.value();
    const pageId = FACEBOOK_PAGE_ID.value();
    const igUserId = INSTAGRAM_BUSINESS_ACCOUNT_ID.value();

    // Instagram bruker systembruker-tokenet direkte. Facebooks side-
    // endepunkter krever derimot et utvekslet side-token (se hentSideToken).
    // Hvis utvekslingen feiler, faller vi tilbake på systembruker-tokenet
    // slik at Instagram-posting uansett ikke stopper opp.
    let sideToken = systemBrukerToken;
    try {
      sideToken = await hentSideToken(pageId, systemBrukerToken);
    } catch (err) {
      logger.error("Klarte ikke å hente side-token, faller tilbake på systembruker-tokenet", err);
    }

    const snapshot = await db
      .collection("innlegg")
      .where("status", "==", "godkjent")
      .get();

    for (const doc of snapshot.docs) {
      const innlegg = doc.data();

      const planlagtTid = innlegg.planlagtTid;
      const skalPostesNaa = !planlagtTid || planlagtTid.toMillis() <= now.toMillis();
      if (!skalPostesNaa) continue;

      const mediaUrl = innlegg.mediaUrl || innlegg.bildeUrl; // bakoverkompatibelt
      const mediaType = innlegg.mediaType || "image";
      const type = innlegg.type || "feed";

      try {
        if (type === "reel" && mediaType !== "video") {
          throw new Error("Reel krever video, men dette innlegget har kun bilde.");
        }

        let postId;
        if (type === "carousel") {
          const mediaItems = innlegg.mediaItems;
          if (!Array.isArray(mediaItems) || mediaItems.length < 2) {
            throw new Error("Karusell krever minst 2 bilder/videoer i mediaItems.");
          }

          if (innlegg.plattform === "facebook") {
            postId = await postTilFacebookCarousel({ mediaItems, tekst: innlegg.tekst, pageId, token: sideToken });
          } else if (innlegg.plattform === "instagram") {
            postId = await postTilInstagramCarousel({ mediaItems, tekst: innlegg.tekst, igUserId, token: systemBrukerToken });
          } else {
            throw new Error(`Ukjent eller manglende plattform: ${innlegg.plattform}`);
          }
        } else if (innlegg.plattform === "facebook") {
          if (type === "story") {
            postId = await postTilFacebookStory({ mediaUrl, mediaType, pageId, token: sideToken });
          } else if (type === "reel") {
            postId = await postTilFacebookReel({ mediaUrl, tekst: innlegg.tekst, pageId, token: sideToken });
          } else {
            postId = await postTilFacebookInnlegg({ mediaUrl, mediaType, tekst: innlegg.tekst, pageId, token: sideToken });
          }
        } else if (innlegg.plattform === "instagram") {
          postId = await postTilInstagram({
            mediaUrl,
            mediaType,
            tekst: innlegg.tekst,
            type,
            igUserId,
            token: systemBrukerToken,
          });
        } else {
          throw new Error(`Ukjent eller manglende plattform: ${innlegg.plattform}`);
        }

        await doc.ref.update({
          status: "postet",
          postId,
          feilmelding: null,
          postetTid: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (err) {
        logger.error(`Feil ved posting av ${doc.id} (${innlegg.plattform}/${type})`, err);
        await doc.ref.update({
          status: "feilet",
          feilmelding: err.message,
        });
      }
    }
  }
);
