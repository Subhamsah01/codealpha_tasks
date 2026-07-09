(() => {
  'use strict';

  const resultEl = document.getElementById('result');
  const expressionEl = document.getElementById('expression');
  const keysEl = document.querySelector('.keys');
  const MAX_DIGITS = 12;

  let currentValue = '0';
  let previousValue = null;
  let operator = null;
  let overwrite = true;

  const OP_SYMBOL = { '+': '+', '-': '−', '*': '×', '/': '÷' };

  function formatNumber(num) {
    if (num === null || Number.isNaN(num) || !Number.isFinite(num)) return 'Error';

    let str;
    if (Number.isInteger(num)) {
      str = num.toString();
    } else {
      str = parseFloat(num.toFixed(8)).toString();
    }

    if (str.replace(/[-.]/g, '').length > MAX_DIGITS) {
      str = num.toExponential(6);
    }
    return str;
  }

  function calculate(a, op, b) {
    switch (op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return b === 0 ? null : a / b;
      default: return b;
    }
  }

  function updateDisplay() {
    resultEl.textContent = currentValue;

    if (operator && previousValue !== null) {
      const preview = !overwrite ? calculate(previousValue, operator, parseFloat(currentValue)) : null;
      const previewText = preview !== null && preview !== undefined
        ? `  ≈ ${formatNumber(preview)}`
        : '';
      expressionEl.textContent = `${formatNumber(previousValue)} ${OP_SYMBOL[operator]}${previewText}`;
    } else {
      expressionEl.innerHTML = '&nbsp;';
    }

    document.querySelectorAll('.key--op').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.op === operator);
    });
  }

  function inputDigit(digit) {
    if (currentValue === 'Error') resetAll();

    if (overwrite) {
      currentValue = digit;
      overwrite = false;
    } else {
      if (currentValue.replace(/[-.]/g, '').length >= MAX_DIGITS) return;
      currentValue = currentValue === '0' ? digit : currentValue + digit;
    }
    updateDisplay();
  }

  function inputDecimal() {
    if (currentValue === 'Error') resetAll();

    if (overwrite) {
      currentValue = '0.';
      overwrite = false;
    } else if (!currentValue.includes('.')) {
      currentValue += '.';
    }
    updateDisplay();
  }

  function chooseOperator(nextOp) {
    if (currentValue === 'Error') return;

    const current = parseFloat(currentValue);

    if (operator && !overwrite) {
      const result = calculate(previousValue, operator, current);
      if (result === null) return showError();
      previousValue = result;
      currentValue = formatNumber(result);
    } else {
      previousValue = current;
    }

    operator = nextOp;
    overwrite = true;
    updateDisplay();
  }

  function equals() {
    if (operator === null || previousValue === null || currentValue === 'Error') return;

    const current = parseFloat(currentValue);
    const result = calculate(previousValue, operator, current);
    if (result === null) return showError();

    currentValue = formatNumber(result);
    previousValue = null;
    operator = null;
    overwrite = true;
    updateDisplay();
  }

  function showError() {
    currentValue = 'Error';
    previousValue = null;
    operator = null;
    overwrite = true;
    updateDisplay();
  }

  function clearAll() {
    resetAll();
    updateDisplay();
  }

  function resetAll() {
    currentValue = '0';
    previousValue = null;
    operator = null;
    overwrite = true;
  }

  function backspace() {
    if (currentValue === 'Error' || overwrite) {
      currentValue = '0';
      overwrite = true;
      updateDisplay();
      return;
    }
    currentValue = currentValue.length > 1 ? currentValue.slice(0, -1) : '0';
    if (currentValue === '-' || currentValue === '') currentValue = '0';
    if (currentValue === '0') overwrite = true;
    updateDisplay();
  }

  function percent() {
    if (currentValue === 'Error') return;
    const value = parseFloat(currentValue);
    const base = previousValue !== null ? previousValue : value;
    const result = previousValue !== null ? (base * value) / 100 : value / 100;
    currentValue = formatNumber(result);
    overwrite = true;
    updateDisplay();
  }

  function handleAction(action, el) {
    switch (action) {
      case 'number': inputDigit(el.dataset.num); break;
      case 'decimal': inputDecimal(); break;
      case 'operator': chooseOperator(el.dataset.op); break;
      case 'equals': equals(); break;
      case 'clear': clearAll(); break;
      case 'backspace': backspace(); break;
      case 'percent': percent(); break;
    }
  }

  /* ---------- Mouse / touch input ---------- */
  keysEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.key');
    if (!btn) return;
    handleAction(btn.dataset.action, btn);
  });

  /* ---------- Keyboard input ---------- */
  const KEY_TO_OP = { '+': '+', '-': '-', '*': '*', '/': '/' };

  window.addEventListener('keydown', (e) => {
    const { key } = e;

    if (/^[0-9]$/.test(key)) {
      inputDigit(key);
      return;
    }
    if (key in KEY_TO_OP) {
      chooseOperator(KEY_TO_OP[key]);
      return;
    }

    switch (key) {
      case '.':
      case ',':
        inputDecimal();
        break;
      case 'Enter':
      case '=':
        e.preventDefault();
        equals();
        break;
      case 'Backspace':
        backspace();
        break;
      case 'Escape':
        clearAll();
        break;
      case '%':
        percent();
        break;
      default:
        break;
    }
  });

  updateDisplay();
})();