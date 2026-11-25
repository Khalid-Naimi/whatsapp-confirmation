// Why an order was not sent to HighDelivery, in the team's French. The checks write short English texts (also used in
// the WooCommerce order notes); anything not listed here is passed through as it is, so no reason is ever hidden.
const RULES = [
  [/^the phone number is not a Moroccan number HighDelivery accepts$/u, () => 'numero de telephone non accepte par High Delivery'],
  [/^the phone number is missing$/u, () => 'numero de telephone manquant'],
  [/^the city is missing$/u, () => 'ville manquante'],
  [/^the address is missing$/u, () => 'adresse manquante'],
  [/^the order has no items$/u, () => 'aucun article dans la commande'],
  [/^the order total is not a positive amount$/u, () => 'total de la commande a 0'],
  [/^no HighDelivery product is mapped to "(.+)"$/u, (m) => `"${m[1]}" : pas relie a un produit High Delivery (ouvrir Matching)`],
  [/^"(.+)" \(for "(.+)"\) is not in the HighDelivery warehouse$/u, (m) => `"${m[2]}" : "${m[1]}" n'existe pas dans le stock High Delivery`],
  [/^not enough "(.+)" in the HighDelivery warehouse \((-?\d+) available, (\d+) needed\)$/u, (m) => `stock insuffisant chez High Delivery : "${m[1]}" (disponible ${m[2]}, demande ${m[3]})`],
  [/^"(.+)" is marked as not a HighDelivery product$/u, (m) => `"${m[1]}" : marque comme produit hors High Delivery`],
  [/^"(.+)" is on hold and cannot be sent automatically$/u, (m) => `"${m[1]}" : en pause, pas d'envoi automatique`],
  [/^HighDelivery item \d+ \("(.*)"\) linked to "(.+)" no longer exists$/u, (m) => `"${m[2]}" : le produit High Delivery relie ("${m[1]}") n'existe plus`],
  [/^the link document of "(.+)" cannot be read \(.*\)$/u, (m) => `"${m[1]}" : lien produit illisible (ouvrir Matching)`],
  [/City '(.+)' is not served by the new HighDelivery platform\./u, (m) => `ville "${m[1]}" non desservie par High Delivery`]
];

export function hdReasonInFrench(detail) {
  return String(detail || '')
    .split(/;\s+/u)
    .filter(Boolean)
    .map((part) => {
      for (const [pattern, say] of RULES) {
        const match = part.match(pattern);
        if (match) {
          return say(match);
        }
      }
      return part;
    })
    .join('; ');
}
