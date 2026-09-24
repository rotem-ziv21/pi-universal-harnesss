# Jev לפי התיעוד הרשמי: מה למדתי, ואיפה ההרנס סוטה מזה

תאריך: 2026-09-24 · מקורות: docs.typesafe.ai (introduction, state, how-to-build, noul, choice, score, confidence, patterns, jaggedness jev-1.13, cookbooks, agent skill). מחליף את `שאלות-jev-בסיום.md` מהבוקר.

## מה Jev הוא, במילים של typesafe

מודל System One. מקבל `state` ו־`questions`, מחזיר מספרים. לא כותב טקסט, לא מנמק, לא בוחר צעד הבא. שלוש פרימיטיבות:

- Noul: הסתברות שהיגד נכון, 0 עד 1. בלי confidence נפרד, המספר הוא התשובה והוודאות ביחד.
- Choice: בחירה מרשימה, עם התפלגות ועם confidence.
- Score: מיקום על סולם רמות שאתה כותב, עם התפלגות ועם confidence.

כל השאלות בבקשה נענות במקביל ובבידוד, על אותו state. עשר שאלות עולות כמעט כמו שאלה אחת בזמן, ורק בטוקנים של קלט. פלט חינם. 64k טוקנים לבקשה, 32k ל־state. כ־100ms. סטיית תקן של 0.01 בין ריצות חוזרות, מול 0.1 עד 0.3 אצל LLM כשופט.

המשפט שמסכם את כל הגישה, מהמדריך שלהם: **"code owns the workflow; the model supplies programmable common sense where ordinary code needs semantic understanding."**

## עשרת הכללים שחשובים לנו

1. **קוד קודם.** כל מה שדטרמיניסטי נשאר בקוד: ספירה, חשבון, תאריכים, קודי יציאה. Jev לא יודע לספור ולא לחשב. "Jev is not a calculator."
2. **פירוק.** "This is probably the most important concept in this guide." שאלה רחבה מסתירה כמה שיפוטים. הדוגמה שלהם היא בדיוק שלנו: "האם ה־tool trace נכון?" זו שאלה רעה. הפירוק הנכון: שאלה לכל ארגומנט, לכל קריאה. הקוד מחבר.
3. **קריאה מילולית.** "Jev answers the question you wrote, not the one you meant." מילות היקף, שלילות, תנאים משתמעים, הכל נקרא כלשונו. אם אתה מוצא את עצמך מסביר "מה התכוונתי", ההסבר הזה הוא החצי החסר של ההוראה.
4. **קריטריונים מפורשים.** `true` ו־`false` שאומרים במילים פשוטות מה נחשב כן ומה נחשב לא, כולל מקרי גבול. הוראה וקריטריונים חייבים להסכים; שאלה שבה `true` פירושו "לא" מבלבלת אותו.
5. **קוטביות.** לנסח כך שערך גבוה פירושו כן. "האם ההודעה מכילה מידע אישי" ולא "האם ההודעה נקייה ממידע אישי".
6. **state קטן וממוקד.** "Accuracy falls as the state grows with content unrelated to the decision." לסנן בקוד לפני, לשלוח רק את השדות שהשאלה צריכה, לתת לשדות שמות, ולהצביע עליהם מהשאלה ב־backticks: `checks[0].passed`.
7. **מבנה בשאלות.** כשחלק מהשאלה מגיע מקוד (רשומה, ערך, פריט), הוא נכנס לשדה משלו בתוך `instructions`, לא מודבק לתוך משפט. אותה שאלה, מפתחות שונים שנוצרו בקוד: `same_as_record_18`. זה הדפוס לרשימת בדיקות.
8. **ניתוב על אי־ודאות.** שלושה מסלולים: לפעול, לשאול אדם, להסלים. Noul בין 0.3 ל־0.7 הוא "לא בטוח", לא "בינוני". הסף תלוי במחיר הטעות: גבוה כשלפעול על כן שגוי יקר, נמוך כשלפספס כן יקר.
9. **Score לדרגה, Noul להיגד.** אם השאלה היא "כמה", זו Score עם רמות שכל אחת מתארת מצב קונקרטי. Noul על "כמה" מחזיר הסתברות של היגד, לא מידה.
10. **תוכן עוין הוא נתון.** Jev לא מתייחס ל־state כעוין. טקסט שטוען על עצמו ("הכל עבר") יכול להזיז את התשובה. לכן: השאלות על הראיות מצביעות על שדות הראיות, לא על ההודעה של המודל.

## איפה ההרנס הישן שבר את הכללים האלה

- **שאלה רחבה ומילולית.** "האם הדרישה מודגמת מספיק על ידי ראיות זמן ריצה" זו כלל 2 וכלל 3 יחד. Jev ענה כלשונו: 0.57. העבודה הייתה נכונה.
- **state ענק.** `JudgeState` עם bundles, excluded lists, hypotheses, counters, ועשרות תצפיות. כלל 6. הדוקומנטציה קוראת לזה context rot ומזהירה במפורש.
- **קוטביות הפוכה.** תנאי אסור "נוצר קובץ אחר" נשאל כמו שהוא. כלל 5, ובדיוק המקרה שראינו: אותן עובדות, תוויות הפוכות בין ניסיון לניסיון.
- **ספירה במודל.** "הדוח מכיל חמישה מונחים" הלך לסוקר ול־Jev. כלל 1. זה grep.
- **מודל שפה בתוך מסלול ההחלטה.** קומפיילר וסוקר. הסקירה ההשוואתית כבר אמרה את זה, והדוקומנטציה אומרת את זה מהכיוון השני: "AI-powered software, not agents".
- **הסתמכות על שופט LLM לעקביות.** הסוקר החזיר VERIFIED ואז NOT_VERIFIED על אותן עובדות. ה־cookbook של העקביות מודד בדיוק את זה: LLM זז גם בטמפרטורה 0. Jev לא.

## איפה הבראנץ' החדש מתיישר, ואיפה עדיין לא

מתיישר: שאלות קבועות, אותן שאלות לכל מודל, ספים בקוד, state קטן, קריטריונים true/false, "none of these" ב־choice. זה לפי הספר.

לא מתיישר, בשער הסיום:

- **השאלה הרחבה חזרה בדלת האחורית.** "האם `final_message` מציג את העבודה כגמורה" זו שאלה על **הטענה**, לא על **העבודה**. Jev לא נשאל אף פעם אם הראיות מראות שמה שביקשו נעשה. זה כלל 10 הפוך: שואלים את המודל העוין על עצמו.
- **אין פירוק לפריטים.** בקשה עם שישה deliverables נשפטת כיחידה אחת, ורק דרך "עבר טסט אחרי השינוי האחרון". טסט שעובר על שלושה מתוך שישה נותן "מאומת". כלל 2.
- **משימות בלי טסט מקבלות "לא מאומת" אוטומטית.** מסמך, מחקר, notes. הראיות שלהן (קבצים שנוצרו, דפים שנפתחו) לא נשאלות בכלל.

## התכנון המתוקן לשער הסיום, לפי הספר

### state

```
request:        מילות המשתמש, כמו שהן
request_items:  הבקשה מפורקת בקוד לפריטים: לפי מספור, bullets, או משפטים. בלי מודל.
changes:        [{path, kind: created|modified|deleted, head: 600 תווים ראשונים}]
checks:         [{command, passed, summary}] רק פקודות בדיקה, כמו היום
observations:   [{command, exit_ok, summary}] פקודות אחרות שהריצו (curl, ls, cat), מקוצר
final_message:  ההודעה האחרונה של המודל, מקוצרת
```

מסונן בקוד, מתחת ל־32k. בלי היסטוריה, בלי היפותזות, בלי מונים.

### שאלות, קבועות בצורה, מיוצרות בקוד לכל פריט

לכל `request_items[i]` שתי שאלות. ההוראה היא אובייקט, הפריט בשדה משלו, כמו `same_as_record_18` בדוקומנטציה:

```
item_i_done:    noul
  instructions: { item: <הטקסט של הפריט>,
                  question: "Do `changes`, `checks` and `observations` show that `item` was carried out?" }
  criteria:     true:  "A changed file, a passed check, or an observation shows the thing `item` describes exists or behaves as described."
                false: "Nothing in `changes`, `checks` or `observations` shows it; a claim in `final_message` alone does not count."

item_i_checked: noul
  instructions: { item: <הטקסט>,
                  question: "Does an entry in `checks` with `passed` true exercise what `item` describes?" }
```

ועוד שלוש שאלות קבועות על הכלל:

```
claim_beyond_evidence: noul
  "Does `final_message` claim a result that `checks`, `changes` and `observations` do not show?"
  true:  "It states something passed, works, or exists that no entry shows."
  false: "Every result it states has a matching entry, or it claims nothing."

outcome: choice (קיים היום): complete / partial / blocked / question / other

completeness: score
  levels: ["Nothing in `request_items` was carried out",
           "Some items were carried out",
           "Most items were carried out",
           "Every item was carried out, but not every one is exercised by a passed check",
           "Every item was carried out and each is exercised by a passed check"]
```

הכל בבקשה אחת. עשרים שאלות על state של 10k טוקנים זה עדיין קריאה אחת ופחות משנייה.

### החלטה, בקוד בלבד

- ספירה בקוד: `done_i ≥ 0.8` נספר כנעשה, `≤ 0.2` כלא נעשה, באמצע "לא בטוח".
- `outcome` הוא question או blocked: קבלה, זו לא הכרזת סיום.
- כל הפריטים נעשו ונבדקו: **done, verified**.
- כל הפריטים נעשו, לא כולם נבדקו: **done, partially verified**, וההודעה מונה מה לא נבדק.
- יש פריט שלא נעשה או `claim_beyond_evidence ≥ 0.7`, ועדיין לא הייתה החזרה: **החזרה אחת**, עם שם הפריט ומה חסר. לא "אסוף ראיות", אלא "פריט 4 לא נמצא ב־changes ולא ב־checks".
- אחרת: **done, not verified**, עם המספרים, כדי שיהיה ברור למה.
- פריטים "לא בטוח" מוצגים למשתמש כרשימה. לא חוסמים ולא מאשרים.

תקרות קיימות נשארות: החזרה אחת לפרומפט, שלוש לסשן.

### מה זה פותר

- shorty עם טסטים חלקיים: item_4_checked נמוך, item_5_checked נמוך, "partially verified: items 4, 5 not exercised by a check". לא "verified".
- מסמך המחקר: item "findings table with URL per row" נענה מ־`changes[0].head` ומ־`observations` של ה־curl. יש ציון, לא "not verified" אוטומטי.
- הגליון של המשתמש ב־playground: בדיוק אותה מבנה. task, מה נעשה, מה נבדק, מה חסר. אנחנו רק בונים אותו בקוד במקום ביד.

## שני דברים על הצנרת, מהתיעוד

- **מסלול ישיר.** האנדפוינט הרשמי הוא `POST https://api.typesafe.ai/v1/systemone` עם מפתח מהקונסולה. יש SDK ל־JavaScript. ההרנס עובד דרך OpenRouter על נתיב `/alpha/decisions`. עובד, אבל זה נתיב אלפא של צד שלישי, ולא בטוח שכל התכונות (instructions כאובייקט, Score, criteria מובנים) עוברות דרכו אחד לאחד. שווה להוסיף ספק `typesafe` ישיר ולתת לקונפיג לבחור. יש לך כבר חשבון.
- **קישור ל־playground מהלוג.** ה־cookbooks שלהם מייצרים קישור שפותח את ה־state והשאלות בקונסולה. `/harness why` יכול להדפיס קישור כזה לכל החלטה. זה הופך כל דחייה למשהו שאתה פותח בדפדפן, מזיז שאלה, ורואה מה משתנה. הדרך שלהם לכוון ספים.

## מה לא משתנה

- מודל חלש כותב קוד חלש. ההרנס מדווח נכון.
- הספים הם התחלה. "Treat cookbook thresholds and demo results as examples to evaluate, not universal rules." לכוון על הלוג.
- הכל ייבדק לראשונה מול Jev אמיתי במכונה עם מפתח.
