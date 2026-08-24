export class UI {
  constructor({ onNewGame, onDifficultyChange }) {
    this.turnEl = document.getElementById('turn-indicator');
    this.moveListEl = document.getElementById('move-list');
    this.statusEl = document.getElementById('game-status');
    this.newGameBtn = document.getElementById('new-game');
    this.diffButtons = Array.from(document.querySelectorAll('.diff-btn'));

    this.newGameBtn.addEventListener('click', () => onNewGame());
    this.diffButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.diffButtons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        onDifficultyChange(btn.dataset.level);
      });
    });
  }

  setTurn(color, thinking = false) {
    if (thinking) {
      this.turnEl.textContent = 'The AI is thinking…';
      return;
    }
    this.turnEl.textContent = color === 'w' ? 'White to move' : 'Black to move';
  }

  setStatus(text) {
    this.statusEl.textContent = text || '';
  }

  renderHistory(history) {
    this.moveListEl.innerHTML = '';
    for (let i = 0; i < history.length; i += 2) {
      const li = document.createElement('li');
      const white = history[i] || '';
      const black = history[i + 1] || '';
      li.textContent = black ? `${white}   ${black}` : white;
      this.moveListEl.appendChild(li);
    }
    this.moveListEl.scrollTop = this.moveListEl.scrollHeight;
  }
}
