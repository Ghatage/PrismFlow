const MAX_PREFIX_LENGTH = 40;

const activeToken = (textarea) => {
  const caret = textarea.selectionStart;
  if (caret !== textarea.selectionEnd) return null;
  const upToCaret = textarea.value.slice(0, caret);
  const at = upToCaret.lastIndexOf('@');
  if (at === -1) return null;
  if (at > 0 && /[\w@]/.test(upToCaret[at - 1])) return null;
  const prefix = upToCaret.slice(at + 1);
  if (prefix.includes('\n') || prefix.length > MAX_PREFIX_LENGTH) return null;
  return {at, caret, prefix};
};

export const attachMentionAutocomplete = (textarea, {getCharacters, onInsert}) => {
  let menu = null;
  let matches = [];
  let activeIndex = 0;
  let token = null;

  const close = () => {
    menu?.remove();
    menu = null;
    matches = [];
    token = null;
  };

  const select = (character) => {
    const replacement = `@${character.name} `;
    const value = textarea.value;
    textarea.value = value.slice(0, token.at) + replacement + value.slice(token.caret);
    const caret = token.at + replacement.length;
    textarea.setSelectionRange(caret, caret);
    close();
    onInsert({characterId: character.id, name: character.name});
    textarea.dispatchEvent(new Event('input', {bubbles: true}));
    textarea.focus();
  };

  const renderMenu = () => {
    if (!matches.length) { close(); return; }
    if (!menu) {
      menu = document.createElement('div');
      menu.className = 'mention-menu';
      document.body.append(menu);
    }
    menu.textContent = '';
    matches.forEach((character, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = index === activeIndex ? 'active' : '';
      const name = document.createElement('strong');
      name.textContent = character.name;
      const note = document.createElement('small');
      note.textContent = `${character.versions.length} version${character.versions.length === 1 ? '' : 's'}`;
      button.append(name, note);
      button.addEventListener('pointerdown', (event) => { event.preventDefault(); select(character); });
      menu.append(button);
    });
    const rect = textarea.getBoundingClientRect();
    menu.style.left = `${Math.round(rect.left)}px`;
    menu.style.top = `${Math.round(Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8))}px`;
    menu.style.minWidth = `${Math.round(Math.min(rect.width, 260))}px`;
  };

  const update = () => {
    token = activeToken(textarea);
    if (!token) { close(); return; }
    const prefix = token.prefix.toLowerCase();
    matches = (getCharacters() || [])
      .filter((character) => character.versions?.length && character.name?.trim())
      .filter((character) => character.name.toLowerCase().startsWith(prefix))
      .slice(0, 8);
    activeIndex = 0;
    renderMenu();
  };

  textarea.addEventListener('input', update);
  textarea.addEventListener('click', update);
  textarea.addEventListener('blur', () => close());
  textarea.addEventListener('keydown', (event) => {
    if (!menu) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = (activeIndex + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
      renderMenu();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      select(matches[activeIndex]);
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  });
  return close;
};
