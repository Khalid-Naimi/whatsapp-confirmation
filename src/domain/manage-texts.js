// Default customer texts of the "manage my order" page (/suivi). Kept apart from config.js so the confirmation service
// can fall back to them without loading the environment. The headers are the first line above the normal confirmation.
export const MANAGE_TEXTS = Object.freeze({
  updatedHeader: "La commande #{{orderId}} est mise à jour. Réponds 1 à ce message, l'ancien ne compte plus.",
  replacementHeader: 'La commande #{{oldOrderId}} sera annulée et remplacée par la #{{orderId}}. Réponds 1 pour valider. Sans réponse, la #{{oldOrderId}} reste.',
  replacementTooLate: "Trop tard : la commande #{{oldOrderId}} est déjà partie, rien n'a changé.",
  replacementFailed: "La modification n'a pas pu se faire, la commande #{{oldOrderId}} reste comme avant.",
  replacementKept: 'La commande #{{oldOrderId}} reste comme avant.'
});
