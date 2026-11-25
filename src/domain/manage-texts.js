// Default customer texts of the "manage my order" page (/suivi). Kept apart from config.js so the confirmation service
// can fall back to them without loading the environment. The headers are the first line above the normal confirmation.
export const MANAGE_TEXTS = Object.freeze({
  updatedHeader: "La commande #{{orderId}} est mise à jour. Réponds 1 à ce message, l'ancien ne compte plus.",
  replacementHeader: 'La commande #{{oldOrderId}} sera annulée et remplacée par la #{{orderId}}. Réponds 1 pour valider. Sans réponse, la #{{oldOrderId}} reste.',
  replacementTooLate: "Trop tard : la commande #{{oldOrderId}} est déjà partie, rien n'a changé.",
  replacementFailed: "La modification n'a pas pu se faire, la commande #{{oldOrderId}} reste comme avant.",
  replacementKept: 'La commande #{{oldOrderId}} reste comme avant.',
  // A new address or phone after the order was confirmed: nothing changes until the customer answers 1.
  contactAddress: "La commande #{{orderId}} : nouvelle adresse : {{value}}\nRéponds 1 pour valider. Sans réponse, l'ancienne adresse reste.",
  contactPhone: "La commande #{{orderId}} : nouveau numéro : {{value}}\nRéponds 1 pour valider. Sans réponse, l'ancien numéro reste.",
  contactDoneAddress: "C'est fait : la commande #{{orderId}} a la nouvelle adresse.",
  contactDonePhone: "C'est fait : la commande #{{orderId}} a le nouveau numéro.",
  contactKeptAddress: "La commande #{{orderId}} garde l'ancienne adresse.",
  contactKeptPhone: "La commande #{{orderId}} garde l'ancien numéro.",
  contactTooLate: "Trop tard : la commande #{{orderId}} est déjà partie, rien n'a changé.",
  contactFailed: "La modification n'a pas pu se faire, la commande #{{orderId}} reste comme avant.",
  // The parcel may or may not carry the change: nothing is promised either way.
  contactChecking: 'On vérifie la modification de la commande #{{orderId}} et on te confirme.'
});
