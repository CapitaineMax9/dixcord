'use strict'

module.exports = {
  PROTOCOL_VERSION: 1,

  // Taille maximale d'une trame réseau (en-tête JSON + données binaires).
  MAX_FRAME_SIZE: 4 * 1024 * 1024,
  // Taille maximale d'un événement signé une fois sérialisé.
  MAX_EVENT_SIZE: 64 * 1024,

  MAX_TEXT_LENGTH: 4000,
  MAX_USER_NAME_LENGTH: 32,
  MAX_SERVER_NAME_LENGTH: 48,
  MAX_CHANNEL_NAME_LENGTH: 32,
  MAX_FILE_NAME_LENGTH: 255,
  MAX_FILES_PER_MESSAGE: 10,
  MAX_FILE_SIZE: 100 * 1024 * 1024,

  FILE_CHUNK_SIZE: 64 * 1024,
  FILE_TIMEOUT: 20 * 1000,

  // Taille visée pour un lot d'événements envoyé pendant une synchronisation.
  SYNC_BATCH_BYTES: 512 * 1024,
  // Fréquence à laquelle on recompare les historiques avec les pairs connectés.
  ANTI_ENTROPY_INTERVAL: 30 * 1000,
  // Relance de la recherche de pairs quand on est seul sur un serveur.
  LONELY_REFRESH_MIN: 5 * 1000,
  LONELY_REFRESH_MAX: 60 * 1000,
  TICK_INTERVAL: 5 * 1000,
  // Délai avant de fermer une connexion qui ne partage aucun serveur avec nous.
  USELESS_PEER_GRACE: 30 * 1000,

  // Présence relayée : utile quand deux membres ne peuvent pas se connecter
  // directement (4G/5G, réseaux d'école ou d'entreprise…).
  PRESENCE_INTERVAL: 15 * 1000,
  PRESENCE_TTL: 40 * 1000,
  // Nombre maximal de relais pour un signal d'appel.
  RTC_MAX_HOPS: 3
}
