class VoiceDatePicker {
  constructor() {
    this.audioContext = null;
    this.analyser = null;
    this.microphone = null;
    this.dataArray = null;
    this.isListening = false;

    this.currentColumn = 0; // 0: day, 1: month, 2: year
    this.currentDay = 15;
    this.currentMonth = 6;
    this.currentYear = 2024;

    this.submitThreshold = 2.0; // Time in seconds to sustain frequency for submit
    this.actionThreshold = 0.2; // Time in seconds to sustain frequency for navigation actions
    this.lastActionTime = 0;
    this.lastActionZone = null;
    this.currentFrequency = 0;
    this.progressInterval = null;
    this.minMagnitude = 80; // Minimum magnitude to consider as valid input

    // Frequency smoothing
    this.frequencyHistory = [];
    this.historySize = 8; // Number of readings to average

    // Submit stability
    this.isSubmitMode = false;
    this.submitStartTime = 0;
    this.lastValidSubmitTime = 0;
    this.submitGracePeriod = 0.3; // Seconds allowed outside submit zone

    this.minFreq = 80;  // Minimum frequency to consider
    this.maxFreq = 350; // Maximum frequency to consider (much lower for easier singing)

    this.initializeElements();
    this.initializeDatePicker();
    this.setupEventListeners();
  }

  initializeElements() {
    this.startBtn = document.getElementById('start-btn');
    this.interface = document.getElementById('interface');
    this.freqDisplay = document.getElementById('freq');
    this.noteDisplay = document.getElementById('note');
    this.needle = document.getElementById('needle');
    this.progressBar = document.getElementById('progress');
    this.messageEl = document.getElementById('message');

    this.dayNumbers = document.getElementById('day-numbers');
    this.monthNumbers = document.getElementById('month-numbers');
    this.yearNumbers = document.getElementById('year-numbers');

    this.dayCol = document.getElementById('col-day');
    this.monthCol = document.getElementById('col-month');
    this.yearCol = document.getElementById('col-year');
  }

  setupEventListeners() {
    this.startBtn.addEventListener('click', () => this.startMicrophone());
  }

  async startMicrophone() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.audioContext.createAnalyser();
      this.microphone = this.audioContext.createMediaStreamSource(stream);

      this.analyser.fftSize = 4096;
      this.analyser.smoothingTimeConstant = 0.8;

      const bufferLength = this.analyser.frequencyBinCount;
      this.dataArray = new Uint8Array(bufferLength);

      this.microphone.connect(this.analyser);

      this.startBtn.style.display = 'none';
      this.interface.classList.remove('hidden');
      this.isListening = true;

      this.analyze();

    } catch (error) {
      console.error('Error accessing microphone:', error);
      this.messageEl.textContent = 'Error: Could not access microphone';
    }
  }

  analyze() {
    if (!this.isListening) return;

    this.analyser.getByteFrequencyData(this.dataArray);

    const frequency = this.getFrequency();
    this.currentFrequency = frequency;

    this.updateDisplay(frequency);
    this.updateNeedle(frequency);
    this.processVoiceCommand(frequency);

    requestAnimationFrame(() => this.analyze());
  }

  getFrequency() {
    const nyquist = this.audioContext.sampleRate / 2;
    const binSize = nyquist / this.analyser.frequencyBinCount;

    let maxMagnitude = 0;
    let maxIndex = 0;

    // Find the frequency bin with the highest magnitude
    for (let i = 0; i < this.dataArray.length; i++) {
      if (this.dataArray[i] > maxMagnitude) {
        maxMagnitude = this.dataArray[i];
        maxIndex = i;
      }
    }

    // Convert bin index to frequency
    const frequency = maxIndex * binSize;

    // Only return frequency if it's above a higher threshold and in our range
    if (maxMagnitude > this.minMagnitude && frequency >= this.minFreq && frequency <= this.maxFreq) {
      return this.smoothFrequency(frequency);
    }

    return this.smoothFrequency(0);
  }

  smoothFrequency(frequency) {
    // Add to history
    this.frequencyHistory.push(frequency);

    // Keep only recent history
    if (this.frequencyHistory.length > this.historySize) {
      this.frequencyHistory.shift();
    }

    // Calculate weighted average (more recent = higher weight)
    let sum = 0;
    let weightSum = 0;

    for (let i = 0; i < this.frequencyHistory.length; i++) {
      const weight = i + 1; // Linear weighting: 1, 2, 3, ... (more recent = higher weight)
      sum += this.frequencyHistory[i] * weight;
      weightSum += weight;
    }

    return weightSum > 0 ? sum / weightSum : 0;
  }

  updateDisplay(frequency) {
    this.freqDisplay.textContent = `Frequency: ${frequency.toFixed(1)} Hz`;

    // Convert frequency to musical note (optional)
    const note = this.frequencyToNote(frequency);
    this.noteDisplay.textContent = `Note: ${note}`;
  }

  updateNeedle(frequency) {
    if (frequency === 0) return;

    // Map frequency to tuner position (0-100%)
    const position = this.mapFrequencyToPosition(frequency);
    this.needle.style.left = `${position}%`;
  }

  mapFrequencyToPosition(frequency) {
    // Map frequency range to 0-100% of tuner width
    const normalizedFreq = (frequency - this.minFreq) / (this.maxFreq - this.minFreq);
    return Math.max(0, Math.min(100, normalizedFreq * 100));
  }

  getFrequencyZone(frequency) {
    const position = this.mapFrequencyToPosition(frequency);

    if (position < 25) return 'low';      // Move down
    if (position < 50) return 'mid';      // Move up
    if (position < 75) return 'high';     // Next element
    return 'submit';                      // Submit
  }

  frequencyToNote(frequency) {
    if (frequency === 0) return '--';

    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const A4 = 440;
    const C0 = A4 * Math.pow(2, -4.75);

    if (frequency > C0) {
      const h = Math.round(12 * Math.log2(frequency / C0));
      const octave = Math.floor(h / 12);
      const n = h % 12;
      return noteNames[n] + octave;
    }
    return '--';
  }

  processVoiceCommand(frequency) {
    if (frequency === 0) {
      this.resetProgress();
      this.lastActionZone = null;
      return;
    }

    const zone = this.getFrequencyZone(frequency);
    const currentTime = Date.now();

    // Handle submit mode with tolerance
    if (this.isSubmitMode) {
      this.handleSubmitMode(zone, currentTime);
      return;
    }

    // Handle regular navigation
    if (zone === 'submit') {
      this.enterSubmitMode(currentTime);
    } else {
      this.handleNavigationZone(zone, currentTime);
    }
  }

  enterSubmitMode(currentTime) {
    this.isSubmitMode = true;
    this.submitStartTime = currentTime;
    this.lastValidSubmitTime = currentTime;
    this.startProgress();
    this.lastActionZone = 'submit';
  }

  handleSubmitMode(zone, currentTime) {
    const totalSubmitTime = (currentTime - this.submitStartTime) / 1000;

    // Simplified: just check if we're in submit zone (with small grace for high zone)
    if (zone === 'submit' || zone === 'high') {
      // In valid zone - update valid time
      this.lastValidSubmitTime = currentTime;
    } else {
      // Outside valid zones - check grace period
      const timeOutsideZone = (currentTime - this.lastValidSubmitTime) / 1000;

      if (timeOutsideZone > this.submitGracePeriod) {
        // Grace period exceeded - reset submit mode
        this.resetSubmitMode();
        return;
      }
    }

    // Update progress bar styling
    this.updateProgressBarStyle(totalSubmitTime);

    // Check if we've sustained long enough
    if (totalSubmitTime >= this.submitThreshold) {
      this.executeAction('submit');
      this.resetSubmitMode();
    }
  }

  handleNavigationZone(zone, currentTime) {
    // If this is a new zone or we haven't started tracking time yet
    if (zone !== this.lastActionZone) {
      this.lastActionTime = currentTime;
      this.lastActionZone = zone;
      return;
    }

    // Calculate how long we've been in this zone
    const sustainedTime = (currentTime - this.lastActionTime) / 1000;

    // For navigation zones, require sustained frequency
    if (sustainedTime >= this.actionThreshold) {
      this.executeAction(zone);
      this.lastActionZone = null;
    }
  }

  updateProgressBarStyle(totalSubmitTime) {
    // Simplified color coding
    let backgroundColor = '#00ff99'; // Just green

    this.progressBar.style.background = backgroundColor;

    // Update message with countdown
    const remaining = Math.max(0, this.submitThreshold - totalSubmitTime);
    if (remaining > 0) {
      this.messageEl.innerHTML = `<div style="color: ${backgroundColor}">🎵 Submitting in ${remaining.toFixed(1)}s...</div>`;
    }
  }

  resetSubmitMode() {
    this.isSubmitMode = false;
    this.resetProgress();
    this.lastActionZone = null;
    this.messageEl.innerHTML = '';
  }

  startProgress() {
    this.progressBar.style.width = '0%';

    this.progressInterval = setInterval(() => {
      if (!this.isSubmitMode) {
        this.resetProgress();
        return;
      }

      const elapsed = (Date.now() - this.submitStartTime) / 1000;
      const progress = (elapsed / this.submitThreshold) * 100;

      this.progressBar.style.width = `${Math.min(progress, 100)}%`;

      if (progress >= 100) {
        this.resetProgress();
      }
    }, 50);
  }

  resetProgress() {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
    this.progressBar.style.width = '0%';
    this.progressBar.style.background = 'limegreen'; // Reset to default color
    this.lastActionTime = 0;
    this.isSubmitMode = false;
    this.messageEl.innerHTML = '';
  }

  executeAction(zone) {
    switch (zone) {
      case 'low':
        this.moveDown();
        break;
      case 'mid':
        this.moveUp();
        break;
      case 'high':
        this.nextColumn();
        break;
      case 'submit':
        this.submitDate();
        break;
    }
  }

  initializeDatePicker() {
    this.generateDays();
    this.generateMonths();
    this.generateYears();
    this.updateActiveColumn();
    this.updateSelections();
  }

  generateDays() {
    this.dayNumbers.innerHTML = '';
    for (let i = 1; i <= 31; i++) {
      const div = document.createElement('div');
      div.textContent = i;
      if (i === this.currentDay) div.classList.add('active');
      this.dayNumbers.appendChild(div);
    }
  }

  generateMonths() {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    this.monthNumbers.innerHTML = '';
    months.forEach((month, index) => {
      const div = document.createElement('div');
      div.textContent = month;
      if (index + 1 === this.currentMonth) div.classList.add('active');
      this.monthNumbers.appendChild(div);
    });
  }

  generateYears() {
    this.yearNumbers.innerHTML = '';
    for (let i = 1900; i <= 2030; i++) {
      const div = document.createElement('div');
      div.textContent = i;
      if (i === this.currentYear) div.classList.add('active');
      this.yearNumbers.appendChild(div);
    }
  }

  updateActiveColumn() {
    [this.dayCol, this.monthCol, this.yearCol].forEach((col, index) => {
      col.classList.toggle('active', index === this.currentColumn);
    });
  }

  updateSelections() {
    // Update day
    const dayElements = this.dayNumbers.children;
    Array.from(dayElements).forEach((el, index) => {
      el.classList.toggle('active', index + 1 === this.currentDay);
    });

    // Update month
    const monthElements = this.monthNumbers.children;
    Array.from(monthElements).forEach((el, index) => {
      el.classList.toggle('active', index + 1 === this.currentMonth);
    });

    // Update year
    const yearElements = this.yearNumbers.children;
    Array.from(yearElements).forEach((el, index) => {
      el.classList.toggle('active', 1900 + index === this.currentYear);
    });

    this.scrollToActive();
  }

  scrollToActive() {
    const containers = [this.dayNumbers, this.monthNumbers, this.yearNumbers];
    const values = [this.currentDay - 1, this.currentMonth - 1, this.currentYear - 1900];

    containers.forEach((container, index) => {
      const activeIndex = values[index];
      const offset = activeIndex * 30; // 30px per item
      container.style.transform = `translateY(-${offset - 30}px)`; // Center the active item
    });
  }

  moveUp() {
    switch (this.currentColumn) {
      case 0: // Day
        this.currentDay = Math.min(31, this.currentDay + 1);
        break;
      case 1: // Month
        this.currentMonth = this.currentMonth === 12 ? 1 : this.currentMonth + 1;
        break;
      case 2: // Year
        this.currentYear = Math.min(2030, this.currentYear + 1);
        break;
    }
    this.validateAndUpdate();
  }

  moveDown() {
    switch (this.currentColumn) {
      case 0: // Day
        this.currentDay = Math.max(1, this.currentDay - 1);
        break;
      case 1: // Month
        this.currentMonth = this.currentMonth === 1 ? 12 : this.currentMonth - 1;
        break;
      case 2: // Year
        this.currentYear = Math.max(1900, this.currentYear - 1);
        break;
    }
    this.validateAndUpdate();
  }

  nextColumn() {
    this.currentColumn = (this.currentColumn + 1) % 3;
    this.updateActiveColumn();
  }

  validateAndUpdate() {
    // Validate day against month/year
    const daysInMonth = this.getDaysInMonth(this.currentMonth, this.currentYear);
    if (this.currentDay > daysInMonth) {
      this.currentDay = daysInMonth;
    }

    this.updateSelections();
  }

  getDaysInMonth(month, year) {
    return new Date(year, month, 0).getDate();
  }

  submitDate() {
    const selectedDate = new Date(this.currentYear, this.currentMonth - 1, this.currentDay);
    const formattedDate = selectedDate.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    this.messageEl.innerHTML = `<div class="submitted">=� Selected: ${formattedDate}</div>`;

    // Stop listening
    this.isListening = false;
    if (this.audioContext) {
      this.audioContext.close();
    }
  }
}

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
  new VoiceDatePicker();
});