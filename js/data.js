// Données du plateau et des cartes — noms 100 % originaux.

export const GROUPS = {
  brun:    { label: 'Brun',        color: '#8b5a3c', houseCost: 50 },
  ciel:    { label: 'Bleu ciel',   color: '#8fd3f0', houseCost: 50 },
  rose:    { label: 'Rose',        color: '#d9468f', houseCost: 100 },
  orange:  { label: 'Orange',      color: '#f39a2b', houseCost: 100 },
  rouge:   { label: 'Rouge',       color: '#e0312f', houseCost: 150 },
  jaune:   { label: 'Jaune',       color: '#f5d300', houseCost: 150 },
  vert:    { label: 'Vert',        color: '#1fa45a', houseCost: 200 },
  marine:  { label: 'Bleu marine', color: '#1f4fa8', houseCost: 200 },
};

const P = (name, group, price, rents) => ({ type: 'property', name, group, price, rents });
const G = (name) => ({ type: 'station', name, price: 200 });
const U = (name, icon) => ({ type: 'utility', name, price: 150, icon });

export const BOARD = [
  { type: 'go', name: 'Départ' },
  P('Rue des Lilas', 'brun', 60, [2, 10, 30, 90, 160, 250]),
  { type: 'chest', name: 'Caisse commune' },
  P('Allée des Tilleuls', 'brun', 60, [4, 20, 60, 180, 320, 450]),
  { type: 'tax', name: 'Impôt sur le revenu', amount: 200 },
  G('Gare Centrale'),
  P('Rue du Marché', 'ciel', 100, [6, 30, 90, 270, 400, 550]),
  { type: 'chance', name: 'Chance' },
  P("Place de l'Église", 'ciel', 100, [6, 30, 90, 270, 400, 550]),
  P('Quai des Bateliers', 'ciel', 120, [8, 40, 100, 300, 450, 600]),
  { type: 'jail', name: 'Prison / Simple visite' },
  P('Rue des Artisans', 'rose', 140, [10, 50, 150, 450, 625, 750]),
  U("Compagnie d'Électricité", '⚡'),
  P('Avenue du Parc', 'rose', 140, [10, 50, 150, 450, 625, 750]),
  P('Boulevard du Lac', 'rose', 160, [12, 60, 180, 500, 700, 900]),
  G('Gare du Fleuve'),
  P('Place du Théâtre', 'orange', 180, [14, 70, 200, 550, 750, 950]),
  { type: 'chest', name: 'Caisse commune' },
  P("Rue de l'Horloge", 'orange', 180, [14, 70, 200, 550, 750, 950]),
  P('Avenue des Arts', 'orange', 200, [16, 80, 220, 600, 800, 1000]),
  { type: 'parking', name: 'Parc gratuit' },
  P('Rue du Port', 'rouge', 220, [18, 90, 250, 700, 875, 1050]),
  { type: 'chance', name: 'Chance' },
  P('Cours de la Liberté', 'rouge', 220, [18, 90, 250, 700, 875, 1050]),
  P('Boulevard Océan', 'rouge', 240, [20, 100, 300, 750, 925, 1100]),
  G('Gare des Collines'),
  P('Avenue des Sciences', 'jaune', 260, [22, 110, 330, 800, 975, 1150]),
  P("Place de l'Opéra", 'jaune', 260, [22, 110, 330, 800, 975, 1150]),
  U('Compagnie des Eaux', '💧'),
  P('Rue de la Monnaie', 'jaune', 280, [24, 120, 360, 850, 1025, 1200]),
  { type: 'gotojail', name: 'Allez en prison' },
  P('Avenue des Ambassades', 'vert', 300, [26, 130, 390, 900, 1100, 1275]),
  P('Boulevard Royal', 'vert', 300, [26, 130, 390, 900, 1100, 1275]),
  { type: 'chest', name: 'Caisse commune' },
  P('Place de la Bourse', 'vert', 320, [28, 150, 450, 1000, 1200, 1400]),
  G('Gare Maritime'),
  { type: 'chance', name: 'Chance' },
  P('Avenue du Palais', 'marine', 350, [35, 175, 500, 1100, 1300, 1500]),
  { type: 'tax', name: 'Taxe de luxe', amount: 100 },
  P('Promenade des Étoiles', 'marine', 400, [50, 200, 600, 1400, 1700, 2000]),
];

export const JAIL_POS = 10;
export const GO_SALARY = 200;
export const JAIL_FINE = 50;
export const START_MONEY = 1500;

// Actions de cartes : { kind, ... } interprétées par le moteur.
export const CHANCE_CARDS = [
  { text: 'Avancez jusqu’à la case Départ. Recevez 200 €.', kind: 'moveTo', to: 0 },
  { text: 'Rendez-vous au Boulevard Océan.', kind: 'moveTo', to: 24 },
  { text: 'Rendez-vous à la Rue des Artisans.', kind: 'moveTo', to: 11 },
  { text: 'Rendez-vous à la Gare Centrale.', kind: 'moveTo', to: 5 },
  { text: 'Rendez-vous à la Promenade des Étoiles.', kind: 'moveTo', to: 39 },
  { text: 'Avancez jusqu’à la gare la plus proche. Si elle appartient à un joueur, payez le double du loyer.', kind: 'nearest', target: 'station' },
  { text: 'Avancez jusqu’à la gare la plus proche. Si elle appartient à un joueur, payez le double du loyer.', kind: 'nearest', target: 'station' },
  { text: 'Avancez jusqu’à la compagnie la plus proche. Si elle appartient à un joueur, payez 10 fois le résultat des dés.', kind: 'nearest', target: 'utility' },
  { text: 'La banque vous verse un dividende de 50 €.', kind: 'money', amount: 50 },
  { text: 'Vous êtes libéré de prison. Conservez cette carte.', kind: 'jailCard' },
  { text: 'Reculez de 3 cases.', kind: 'back', steps: 3 },
  { text: 'Allez directement en prison, sans passer par la case Départ.', kind: 'jail' },
  { text: 'Faites des réparations : 25 € par maison, 100 € par hôtel.', kind: 'repairs', house: 25, hotel: 100 },
  { text: 'Excès de vitesse : amende de 15 €.', kind: 'money', amount: -15 },
  { text: 'Vous présidez le conseil de quartier : versez 50 € à chaque joueur.', kind: 'payEach', amount: 50 },
  { text: 'Votre placement immobilier rapporte 150 €.', kind: 'money', amount: 150 },
];

export const CHEST_CARDS = [
  { text: 'Avancez jusqu’à la case Départ. Recevez 200 €.', kind: 'moveTo', to: 0 },
  { text: 'Erreur de la banque en votre faveur : recevez 200 €.', kind: 'money', amount: 200 },
  { text: 'Consultation chez le médecin : payez 50 €.', kind: 'money', amount: -50 },
  { text: 'Vente de vos actions : recevez 50 €.', kind: 'money', amount: 50 },
  { text: 'Vous êtes libéré de prison. Conservez cette carte.', kind: 'jailCard' },
  { text: 'Allez directement en prison, sans passer par la case Départ.', kind: 'jail' },
  { text: 'Votre épargne vacances arrive à échéance : recevez 100 €.', kind: 'money', amount: 100 },
  { text: 'Remboursement d’impôts : recevez 20 €.', kind: 'money', amount: 20 },
  { text: 'C’est votre anniversaire : chaque joueur vous offre 10 €.', kind: 'collectEach', amount: 10 },
  { text: 'Votre assurance vie arrive à échéance : recevez 100 €.', kind: 'money', amount: 100 },
  { text: 'Frais d’hôpital : payez 100 €.', kind: 'money', amount: -100 },
  { text: 'Frais de scolarité : payez 50 €.', kind: 'money', amount: -50 },
  { text: 'Honoraires de conseil : recevez 25 €.', kind: 'money', amount: 25 },
  { text: 'Travaux de voirie : 40 € par maison, 115 € par hôtel.', kind: 'repairs', house: 40, hotel: 115 },
  { text: 'Deuxième prix de concours de jardinage : recevez 10 €.', kind: 'money', amount: 10 },
  { text: 'Vous héritez de 100 €.', kind: 'money', amount: 100 },
];

export const PLAYER_COLORS = ['#e63946', '#1d7bd8', '#2a9d58', '#f2a541', '#8e44ad', '#16a3a3'];
