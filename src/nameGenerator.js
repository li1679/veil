export function generateHumanNamePrefix(targetLength = 12) {
  const length = Math.max(4, Math.min(32, Math.floor(Number(targetLength) || 12)));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const toAlpha = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const englishFirst = [
    'liam', 'noah', 'oliver', 'elijah', 'james', 'william', 'benjamin', 'lucas', 'henry', 'theodore',
    'jack', 'levi', 'alex', 'mason', 'michael', 'ethan', 'daniel', 'jacob', 'logan', 'sam',
    'sebastian', 'jackson', 'aiden', 'owen', 'wyatt', 'john', 'david', 'joseph', 'carter', 'luke',
    'isaac', 'jayden', 'matthew', 'julian', 'leo', 'nathan', 'ryan', 'adam', 'brian', 'kevin',
    'olivia', 'emma', 'amelia', 'ava', 'sophia', 'isabella', 'mia', 'charlotte', 'harper', 'evelyn',
    'abigail', 'emily', 'ella', 'aria', 'scarlett', 'grace', 'chloe', 'lily', 'zoey', 'nora',
    'hazel', 'riley', 'violet', 'stella', 'hannah', 'audrey', 'alice', 'lucy', 'claire', 'julia'
  ];
  const englishLast = [
    'smith', 'johnson', 'williams', 'brown', 'jones', 'miller', 'davis', 'wilson', 'anderson', 'thomas',
    'taylor', 'moore', 'jackson', 'martin', 'lee', 'thompson', 'white', 'harris', 'clark', 'lewis',
    'robinson', 'walker', 'young', 'allen', 'king', 'wright', 'scott', 'hill', 'green', 'adams',
    'nelson', 'baker', 'hall', 'rivera', 'campbell', 'mitchell', 'carter', 'roberts', 'gomez', 'phillips',
    'evans', 'turner', 'diaz', 'parker', 'cruz', 'edwards', 'collins', 'reyes', 'morris', 'murphy',
    'cook', 'rogers', 'morgan', 'bell', 'cooper', 'richardson', 'ward', 'peterson', 'gray', 'hughes',
    'watson', 'brooks', 'kelly', 'sanders', 'price', 'bennett', 'wood', 'barnes', 'ross', 'henderson',
    'coleman', 'jenkins', 'perry', 'powell', 'long', 'patterson', 'nguyen', 'flores', 'torres', 'ramirez'
  ];
  const firstNames = englishFirst.map(toAlpha).filter(Boolean);
  const lastNames = englishLast.map(toAlpha).filter(Boolean);

  function buildLengthMap(list = []) {
    const map = new Map();
    for (const name of list) {
      const len = name.length;
      if (!map.has(len)) map.set(len, []);
      map.get(len).push(name);
    }
    return map;
  }

  const firstByLen = buildLengthMap(firstNames);
  const lastByLen = buildLengthMap(lastNames);
  const firstLens = Array.from(firstByLen.keys());
  const lastLens = Array.from(lastByLen.keys());

  function pickByLen(map, len) {
    const arr = map.get(len);
    if (!arr || arr.length === 0) return null;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function chooseDigitsCount(totalLen) {
    const maxDigits = Math.max(0, Math.min(4, totalLen - 4));
    if (maxDigits <= 0) return 0;
    const r = Math.random();
    if (r < 0.62) return 0;
    if (r < 0.9) return Math.min(2, maxDigits);
    return Math.min(3, maxDigits);
  }

  function randomDigits(count) {
    if (count <= 0) return '';
    const min = count === 1 ? 0 : Math.pow(10, count - 1);
    const max = Math.pow(10, count) - 1;
    return String(Math.floor(min + Math.random() * (max - min + 1))).padStart(count, '0');
  }

  function buildAlpha(exactLen) {
    if (exactLen <= 6) {
      const hit = pickByLen(firstByLen, exactLen) || pickByLen(lastByLen, exactLen);
      if (hit) return hit;
    }

    for (let attempt = 0; attempt < 160; attempt++) {
      const mode = Math.random();
      if (mode < 0.58) {
        const fl = pick(firstLens);
        const ll = exactLen - fl;
        if (ll < 3) continue;
        const first = pickByLen(firstByLen, fl);
        const last = pickByLen(lastByLen, ll);
        if (first && last) return first + last;
        continue;
      }

      if (mode < 0.78) {
        const fl = pick(firstLens);
        const ll = exactLen - fl - 1;
        if (ll < 3) continue;
        const first = pickByLen(firstByLen, fl);
        const last = pickByLen(lastByLen, ll);
        if (!first || !last) continue;
        const mi = (pick(firstNames) || 'a').slice(0, 1);
        return first + mi + last;
      }

      if (mode < 0.9) {
        const ll = exactLen - 1;
        const last = pickByLen(lastByLen, ll);
        if (!last) continue;
        const fi = (pick(firstNames) || 'a').slice(0, 1);
        return fi + last;
      }

      const fl = pick(firstLens);
      const remain = exactLen - fl;
      if (remain < 6) continue;
      const ll1 = pick(lastLens.filter((l) => l >= 3 && l <= remain - 3));
      if (!ll1) continue;
      const ll2 = remain - ll1;
      const first = pickByLen(firstByLen, fl);
      const last1 = pickByLen(lastByLen, ll1);
      const last2 = pickByLen(lastByLen, ll2);
      if (first && last1 && last2) return first + last1 + last2;
    }

    let base = (pick(firstNames) || 'alex') + (pick(lastNames) || 'smith');
    while (base.length < exactLen) base += (pick(lastNames) || 'lee');
    base = base.slice(0, exactLen);
    if (/^[a-z]+$/.test(base)) return base;
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    let out = '';
    for (let i = 0; i < exactLen; i++) out += letters.charAt(Math.floor(Math.random() * letters.length));
    return out;
  }

  const digitsCount = chooseDigitsCount(length);
  const alphaLen = length - digitsCount;
  return buildAlpha(alphaLen) + randomDigits(digitsCount);
}
