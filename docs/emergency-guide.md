# دليل الطوارئ — اليسير (صفحة واحدة، تُطبع وتوضع قرب الخادم)

**أين النسخ الاحتياطية؟**
- **Google Drive:** المجلد `C:\Alyassir-Sauvegardes` (أو المجلد الذي اخترته)، ويرفعه تطبيق Google Drive وحده.
  - نسخة كل ساعة أثناء الدوام، تُحفظ 30 يومًا.
  - نسخة يومية، تُحفظ 6 أشهر في مجلد لكل شهر.
- **مفتاح USB:** نسخة كل شهر، يوم أول جمعة. آخر 6 نسخ في المجلد `Alyassir` على المفتاح.
- **مرة واحدة بعد التثبيت:** افتح Google Drive، ثم «الإعدادات»، ثم «مجلدات من حاسوبي»، وأضف المجلد.

## 1. الخادم معطّل: «استعادة كخادم» (حوالي ساعة)
1. **أبقِ الخادم القديم مطفأً.** لا يعمل خادمان معًا أبدًا.
2. على حاسوب آخر (Windows 11، 64-bit): شغّل `Alyassir-Setup.exe` كمسؤول.
3. اختر «**استعادة كخادم**».
4. اختر ملف النسخة الأحدث `.dump`:
   - من Google Drive: `hourly` لنسخ كل ساعة، أو مجلد الشهر للنسخ اليومية.
   - أو من مفتاح USB.
   - دع الملف `.sha256` بجانبه.
5. احتفظ بـ**العنوان** و**البصمة** اللذين يظهران في النهاية.
6. يدخل المدير **بكلمة مروره القديمة**، وكذلك الموظفون.
7. **على كل حاسوب مستخدم:** افتح «الاتصال بالخادم»، واكتب العنوان الجديد، وقارن البصمة حرفًا بحرف، ثم احفظ.
8. ضع مفتاح USB الجديد للنسخة الشهرية، وتأكد في شاشة «النسخ الاحتياطية» أن نسخة جديدة أُخذت.

## 2. استعادة نسخة سابقة (الخادم يعمل)
- خطأ كبير في البيانات؟ المدير يفتح «النسخ الاحتياطية»، ويختار النسخة، ثم «استعادة»، ويكتب كلمة مروره.
- يأخذ البرنامج **نسخة أمان** من الوضع الحالي قبل الاستعادة، وتظهر في القائمة باسم «نسخة أمان قبل استعادة».
- بعد الاستعادة يدخل الجميع من جديد.

## 3. أثناء العطل: الوصولات الورقية
- استعمل **دفتر الوصولات الورقية المرقمة مسبقًا**. اكتب الرقم والتاريخ والعميل والمبلغ، واحتفظ بالنسخة.
- بعد عودة الخادم أدخل كل عملية، واكتب رقم الوصل في خانة «**رقم الوصل الورقي**».

## 4. إطفاء الخادم إطفاءً صحيحًا
- من Windows: «ابدأ»، ثم «الطاقة»، ثم «إيقاف التشغيل». **لا تنزع الكهرباء** والحاسوب يعمل.
- عند الإقلاع يعود الخادم وقاعدة البيانات وحدهما، وتؤخذ النسخة اليومية الفائتة تلقائيًا.

---

# Guide d'urgence — Alyassir (une page, à imprimer et garder près du serveur)

**Où sont les sauvegardes ?**
- **Google Drive :** le dossier `C:\Alyassir-Sauvegardes` (ou celui choisi), envoyé tout seul par l'application Google Drive.
  - Une sauvegarde chaque heure pendant les horaires, gardée 30 jours.
  - Une sauvegarde quotidienne, gardée 6 mois, dans un dossier par mois.
- **Clé USB :** une copie chaque mois, le premier vendredi. Les 6 dernières sont dans le dossier `Alyassir` de la clé.
- **Une seule fois après l'installation :** ouvrez Google Drive, puis « Paramètres », puis « Dossiers de mon ordinateur », et ajoutez le dossier.

## 1. Le serveur est en panne : « Restaurer comme serveur » (environ une heure)
1. **Laissez l'ancien serveur éteint.** Jamais deux serveurs en même temps.
2. Sur un autre ordinateur (Windows 11, 64 bits) : lancez `Alyassir-Setup.exe` en administrateur.
3. Choisissez « **Restaurer comme serveur** ».
4. Choisissez le fichier `.dump` le plus récent :
   - dans Google Drive : `hourly` pour les sauvegardes horaires, ou le dossier du mois pour les quotidiennes ;
   - ou sur la clé USB.
   - Laissez le fichier `.sha256` à côté.
5. Notez l'**adresse** et l'**empreinte** affichées à la fin.
6. Le gérant se connecte avec son **ancien mot de passe**, les employés aussi.
7. **Sur chaque poste :** ouvrez « Connexion au serveur », saisissez la nouvelle adresse, comparez l'empreinte caractère par caractère, puis enregistrez.
8. Branchez une nouvelle clé USB pour la copie mensuelle et vérifiez dans l'écran « Sauvegardes » qu'une nouvelle sauvegarde a été faite.

## 2. Revenir à une sauvegarde précédente (le serveur marche)
- Grosse erreur dans les données ? Le gérant ouvre « Sauvegardes », choisit la sauvegarde, puis « Restaurer », et tape son mot de passe.
- Avant de restaurer, le programme fait une **copie de sécurité** de l'état actuel ; elle apparaît dans la liste comme « Copie de sécurité avant restauration ».
- Après la restauration, chacun se reconnecte.

## 3. Pendant la panne : reçus papier
- Utilisez le **carnet de reçus papier pré-numérotés**. Notez le numéro, la date, le client et le montant, et gardez la copie.
- Au retour du serveur, saisissez chaque opération avec le numéro dans le champ « **N° du reçu papier** ».

## 4. Éteindre correctement le serveur
- Dans Windows : « Démarrer », puis « Marche/Arrêt », puis « Arrêter ». **Ne coupez jamais le courant** pendant que l'ordinateur tourne.
- Au démarrage, le serveur et la base reviennent tout seuls ; la sauvegarde quotidienne manquée est faite automatiquement.
