![CHADPOLY](cover.png)

# CHADPOLY

Jeu de plateau immobilier qui se joue dans le navigateur : achetez des rues, construisez maisons et hôtels, échangez avec vos adversaires et ruinez-les. De 2 à 6 joueurs, en ligne (chacun sur son appareil), sur le même écran, ou contre l’ordinateur.

Aucune dépendance, aucune compilation : du HTML, du CSS et du JavaScript (modules ES).

![Une partie en cours](docs/apercu.png)

## Jouer

En local, il faut un petit serveur web (les modules JavaScript ne se chargent pas en ouvrant directement `index.html`) :

```bash
npx serve .
# ou
python3 -m http.server 8000
```

Puis ouvrez <http://localhost:8000> (ou l’adresse affichée par `serve`).

### Jouer en ligne avec des amis

1. Ouvrez le jeu, choisissez **Nouvelle partie → En ligne**, tapez votre nom et cliquez sur **Créer une partie**.
2. Envoyez le lien (bouton **Copier le lien**) ou le code de 5 caractères à vos amis.
3. Vos amis ouvrent le lien, tapent leur nom et cliquent sur **Rejoindre**. Vous pouvez aussi ajouter des joueurs ordinateur.
4. Quand tout le monde est là, cliquez sur **Lancer la partie**.

Bon à savoir :

- Les navigateurs se connectent directement entre eux (WebRTC, via [PeerJS](https://peerjs.com)) : pas de serveur à installer ni à payer.
- L’hôte fait tourner la partie : il doit garder la page ouverte jusqu’à la fin. S’il la recharge, la partie reprend et ses amis se reconnectent tout seuls.
- Un joueur qui recharge sa page ou perd sa connexion reprend sa place automatiquement. S’il ne revient pas, l’hôte peut le faire jouer par l’ordinateur.
- Certains réseaux très fermés (entreprise, école, quelques connexions mobiles) bloquent les connexions directes. Si un ami n’arrive pas à rejoindre, essayez un autre réseau, par exemple le Wi-Fi de la maison.
- Pour tester seul, ouvrez le jeu avec `?transport=local` dans l’adresse : plusieurs onglets du même navigateur jouent alors ensemble sans passer par internet.

### Publier en ligne avec GitHub Pages

1. Poussez le dépôt sur GitHub (voir plus bas).
2. Dans le dépôt : **Settings → Pages → Build and deployment**, source **Deploy from a branch**, branche `main`, dossier `/ (root)`.
3. Après une minute, le jeu est accessible sur <https://tom68160.github.io/monopoly/>.

## Fonctionnalités

- Plateau de 40 cases : 22 rues en 8 couleurs, 4 gares, 2 compagnies, taxes, cartes Chance et Caisse commune (32 cartes).
- Doubles, prison (double, amende ou carte), trois doubles = prison, salaire de 200 € à la case Départ.
- Loyer doublé avec une couleur complète, construction homogène, 32 maisons et 12 hôtels en banque.
- Hypothèques (levée à +10 %), revente des bâtiments à moitié prix.
- Mode en ligne : salon avec code et lien d’invitation, reconnexion automatique, remplacement d’un joueur absent par l’ordinateur.
- Échanges de propriétés et d’argent entre joueurs ; les bots acceptent, refusent, et vous font des offres.
- Faillite : les biens vont au créancier (ou retournent à la banque).
- Durée au choix : jusqu’à la dernière faillite, ou limite de tours (le plus gros patrimoine gagne).
- Sauvegarde automatique dans le navigateur, reprise au rechargement.
- Plateau responsive (ordinateur et mobile), raccourci clavier : <kbd>Espace</kbd> pour lancer les dés ou finir le tour.

## Structure

```
index.html        page et dialogues
css/style.css     styles
js/data.js        plateau, cartes, constantes
js/game.js        moteur de règles (sans DOM, testable)
js/bot.js         intelligence des joueurs ordinateur
js/ui.js          rendu, interactions et mode en ligne
js/net.js         connexion entre navigateurs (PeerJS)
test/             tests du moteur (node:test)
```

## Tests

Node 18 ou plus récent :

```bash
npm test
```

Les tests couvrent les loyers, la construction, la prison, les hypothèques, les échanges, la faillite, la sauvegarde, et simulent 40 parties complètes entre bots. Ils tournent aussi automatiquement sur GitHub à chaque push (`.github/workflows/tests.yml`).

## Pousser sur GitHub

Créez un dépôt **vide** sur <https://github.com/new> (sans README ni licence), puis dans ce dossier :

```bash
git init
git add .
git commit -m "Premier commit : jeu CHADPOLY"
git branch -M main
git remote add origin https://github.com/tom68160/monopoly.git
git push -u origin main
```

## Licence

MIT. CHADPOLY est un jeu original inspiré des jeux de plateau immobiliers classiques ; il n’est affilié à aucune marque.
