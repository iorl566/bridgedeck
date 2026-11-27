# BridgeDeck — he-IL store listing

Locale: `he-IL` (package locale `he`)

Name (from manifest, read-only): `BridgeDeck`

Short description (from manifest `_locales/he/messages.json`, read-only):
BridgeDeck הופך את הדפדפן המחובר שלך לסביבת עבודה עבור סוכן ה-AI. daemon מקומי + תוסף MV3, ללא טלמטריה.

## Description

BridgeDeck הופך את הדפדפן שאתם כבר משתמשים בו לסביבת עבודה עבור סוכן ה-AI שלכם.

תנו לסוכן משימה והוא יעבוד בחלון סוכן נפרד (Agent Window) באמצעות הפעלות שבהן אתם כבר מחוברים, ואתם נשארים בשליטה ויכולים להשתלט בכל רגע.

מה אפשר לעשות

- לעבוד במקום שבו אתם כבר מחוברים: לקרוא מסמכים, לחפש באתרי אינטרנט פנימיים ולהשלים תהליכי ווב שדורשים את החשבון שלכם.
- להפוך הוראות לפעולות בדפדפן: לקרוא את מבנה העמוד, ללחוץ, להקליד, למלא טפסים, לבחור אפשרויות, לגרור, לגלול, להעלות ולהוריד קבצים ולנהל לשוניות.
- להישאר בשליטה: כרטיס שליטה גלוי, מסגרת כחולה נושמת סביב העמוד הנשלט, השהיה ועצירה בכל רגע, ובקשת אישור לפני שהסוכן לווה לשונית משלכם.
- לקחת איתכם נתוני ווב: חילוץ טבלאות ורשימות כ-JSON או CSV, עם שמות העמודות והעמוד או ה-frame שממנו הגיע כל ערך.
- למצוא את הראיות שמאחורי כשל: בקשות, גופי תגובות, הודעות קונסול, שינויי עמוד, זמני ביצועים ובדיקות בקשות כפולות, הכול ניתן לייצוא כ-JSON.
- לשמור הקלטה של העבודה: להקליט לשונית משימה מאושרת כ-MP4 שקט, ואז לצפות, לשמור או למחוק אותה בתוך התוסף.
- לצלם עמודים ארוכים: גלילה אוטומטית, תפר ידני, או רק האזור הנראה.
- לשמור תיעוד: ביקורת פעולות אופציונלית, היסטוריית משימות וראיות, הכול נשמר באופן מקומי.

בנוי עבור סוכנים

CLI אחד, שרת MCP (92 כלים), תוסף DeepSeek Harness (37 כלים) ו-SDK ל-Node.js ול-Python. כל סוכן שיכול להריץ פקודות shell יכול להנהיג את הדפדפן; שום דבר לא תלוי במודל או בספק מסוים.

מקומי ופרטי כברירת מחדל

- מתחבר ל-daemon מקומי בכתובת 127.0.0.1; בלי שירות ענן ובלי טלמטריה.
- צימוד מרחוק הוא אופציונלי ותמיד משתמש ב-WSS מאומת; חיבורים מקומיים ללא צימוד עדיין עובדים, אך מציגים אזהרת זהות.
- צילומי מסך, הקלטות, ראיות דיבוג ורשומות ביקורת נשארים במחשב שלכם.
- התוסף אף פעם לא פונה לספק AI בעצמו.

דרישות

- Microsoft Edge, ‏Google Chrome או דפדפן אחר מבוסס Chromium, גרסה 111 ואילך.
- Node.js 20 ואילך עבור ה-daemon המקומי וה-CLI.
- ה-daemon פועל ב-Windows, ב-macOS וב-Linux. ב-Windows יש מתקין גרפי; ב-macOS וב-Linux משתמשים בקובץ tar.gz עם install.sh.

איך מתחילים

מתקינים את התוסף, פותחים את החלונית הקופצת ומוודאים שמופיע "מחובר". ה-daemon עולה אוטומטית בפעם הראשונה שמריצים פקודת bridge.

קוד המקור, מדריך התקנת ה-CLI והתיעוד: https://github.com/iorl566/bridgedeck

הודעת פרטיות: https://iorl566.github.io/bridgedeck-privacy/privacy-policy.html

## Search terms

- אוטומציה של דפדפן
- סוכן AI
- שליטה בדפדפן
- איסוף נתונים מהאינטרנט
- קריאת עמודים
- שרת MCP
- תוסף Edge

## Notes for the listing editor

- The name and short description are read-only in Partner Center: they come from the package manifest. Change them by updating `extension/_locales/he/messages.json` and re-uploading the package.
- Keep the section headings as capitals or, for caseless script, as clear standalone heading lines; the store page renders the text as plain paragraphs with line breaks.
- Counts (92 MCP tools, 37 plugin tools) are asserted by `tests/unit/mcp-tool-methods.test.mjs` and `tests/unit/dsh-tools.test.mjs`; update this file if those change.
