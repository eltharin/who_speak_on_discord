# Logiciel de connexion au Streamkit de discord



## Installation: 

1- Il faut avoir nodejs installé et dans le path de la machine

    Vous pouvez vérifier en lancant un ``node -v``

2- telecharger le zip et le dézipper ou vous le souhaitez

3- lancer la commande : 

    ```node chemin_de_votre_dossier\src\server.mjs```

Par défaut le server va creer un dossier streams contenant les données utilisateurs au même niveau que le dossier dézippé.

Si vous souhaitez parametrer le dossier de données, vous pouvez lancer la commande avec l'argument streamsPath : 

```node ./src/server.mjs --streamsPath="C:\a\b\c\d\streams"```

Le serveur va automatiquement creer le dossier à cet emplacement. Vous pouvez déplacer vos données vers cet endroit.



Par défaut, le serveur s'execute sur le port 3000, il est possible de le changer via la commande de lancement : 

```node ./src/server.mjs --port=3001 --streamsPath="C:\a\b\c\d\streams"```



