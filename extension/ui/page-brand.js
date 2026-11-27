// ui/page-brand.js —— 页面级品牌头：logo + BridgeDeck / 页面名 + 大标题 + 留白。
// 纯 DOM 注入，不依赖页面各自的 JS；已翻译的 h1 文本作为面包屑。
const header = document.querySelector('.page-header');
if (header && !header.querySelector('.page-brand-row')) {
  const h1 = header.querySelector('h1');
  const back = header.querySelector('.back-btn');
  const row = document.createElement('div');
  row.className = 'page-brand-row';
  const logo = document.createElement('img');
  logo.src = 'assets/brand-mark.svg';
  logo.alt = '';
  logo.width = 22;
  logo.height = 22;
  const name = document.createElement('span');
  name.className = 'page-brand-name';
  name.textContent = 'BridgeDeck';
  const sep = document.createElement('span');
  sep.className = 'page-brand-sep';
  sep.textContent = '/';
  const crumb = document.createElement('span');
  crumb.className = 'page-brand-crumb';
  crumb.textContent = h1 ? h1.textContent.trim() : '';
  row.append(logo, name, sep, crumb);
  if (back) {
    back.classList.add('page-brand-back');
    row.prepend(back);
  }
  header.prepend(row);
}
