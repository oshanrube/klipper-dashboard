class KlipperDashboard {
    constructor() {
        this.printers = JSON.parse(localStorage.getItem('printers')) || [];
        this.pollInterval = parseInt(localStorage.getItem('pollInterval')) || 1;
        this.pollTimer = null;
        this.previousStates = new Map();
        this.notificationsEnabled = false;
        this.websockets = new Map(); // Store WebSocket connections for each printer
        this.reconnectTimers = new Map(); // Store reconnection timers
        
        // Migrate any legacy data formats/URLs before proceeding
        this.migrateLegacyWebcamUrls();
        
        this.initializeDefaultPrinters();
        this.init();
    }

    migrateLegacyWebcamUrls() {
        try {
            if (!Array.isArray(this.printers) || this.printers.length === 0) return;
            let updated = false;
            this.printers = this.printers.map(p => {
                const printer = { ...p };
                if (printer.webcamUrl && /:8080(\/stream|\/\?action=stream)/.test(printer.webcamUrl)) {
                    // Determine IP:PORT from printer.ip or from the webcamUrl itself
                    let ipPort = '';
                    if (printer.ip) {
                        ipPort = String(printer.ip).replace(/^https?:\/\//, '');
                    }
                    if (!ipPort) {
                        try {
                            const u = new URL(printer.webcamUrl);
                            ipPort = u.host; // includes hostname:port
                        } catch (_) {
                            // leave empty if parsing fails
                        }
                    }
                    if (ipPort) {
                        printer.webcamUrl = `http://${ipPort}/webcam/?action=stream`;
                        updated = true;
                    }
                }
                return printer;
            });
            if (updated) {
                this.savePrinters();
            }
        } catch (e) {
            console.warn('Migration of legacy webcam URLs failed:', e);
        }
    }

    initializeDefaultPrinters() {
        if (this.printers.length === 0) {
            // Add default printers from the issue description
            const defaultPrinters = [
                { id: 1, name: 'Mokey D. Luffy', ip: '10.0.68.108:4408', webcamUrl: 'http://10.0.68.108:4408/webcam/?action=stream', disabled: false },
                { id: 2, name: 'Roronoa Zoro', ip: '10.0.68.130:4408', webcamUrl: 'http://10.0.68.130:4408/webcam/?action=stream', disabled: false },
                { id: 3, name: 'Nami', ip: '10.0.68.121:4408', webcamUrl: 'http://10.0.68.121:4408/webcam/?action=stream', disabled: false },
                { id: 4, name: 'Usopp', ip: '10.0.68.116:4408', webcamUrl: 'http://10.0.68.116:4408/webcam/?action=stream', disabled: false },
                { id: 5, name: 'Sanji', ip: '10.0.68.124:4408', webcamUrl: 'http://10.0.68.124:4408/webcam/?action=stream', disabled: false }
            ];
            this.printers = defaultPrinters;
            this.savePrinters();
        }
    }

    init() {
        this.setupEventListeners();
        this.requestNotificationPermission();
        this.renderPrinters();
        this.startWebSocketConnections();
        
        // Set poll interval input value
        document.getElementById('pollInterval').value = this.pollInterval;
    }

    setupEventListeners() {
        // Add printer button
        document.getElementById('addPrinter').addEventListener('click', () => {
            document.getElementById('addPrinterModal').style.display = 'block';
        });

        // Test notification button
        const testBtn = document.getElementById('testNotification');
        if (testBtn) {
            testBtn.addEventListener('click', () => {
                const now = new Date();
                const timeStr = now.toLocaleString();
                this.showNotification('Klipper Dashboard', `This is a test notification (${timeStr})`);
            });
        }

        // Close modal
        document.querySelector('.close').addEventListener('click', () => {
            document.getElementById('addPrinterModal').style.display = 'none';
        });

        // Close modal when clicking outside
        window.addEventListener('click', (event) => {
            const modal = document.getElementById('addPrinterModal');
            if (event.target === modal) {
                modal.style.display = 'none';
            }
        });

        // Add printer form
        document.getElementById('addPrinterForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.addPrinter();
        });

        // Save settings
        document.getElementById('saveSettings').addEventListener('click', () => {
            this.saveSettings();
        });
    }

    async requestNotificationPermission() {
        if ('Notification' in window) {
            const permission = await Notification.requestPermission();
            this.notificationsEnabled = permission === 'granted';
        }
    }

    showNotification(title, body, options = {}) {
        try {
            if (!('Notification' in window)) {
                // Desktop notifications not supported; fallback
                alert(`${title}: ${body}`);
                return;
            }

            const permission = Notification.permission;
            if (permission !== 'granted') {
                // Request permission, then retry if granted
                this.requestNotificationPermission().then(() => {
                    if (this.notificationsEnabled) {
                        this.showNotification(title, body, options);
                    } else {
                        alert(`${title}: ${body}`);
                    }
                });
                return;
            }

            // Permission granted: create desktop notification with sensible defaults
            const defaultIcon = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="%23007bff"/><path d="M9 12.5l2 2 4-4" stroke="white" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            const notifOptions = {
                body,
                icon: options.icon || defaultIcon,
                tag: options.tag,
                requireInteraction: options.requireInteraction ?? false,
                ...options
            };
            const n = new Notification(title, notifOptions);
            n.onclick = () => {
                try {
                    window.focus();
                    if (options.onClickUrl) {
                        window.open(options.onClickUrl, '_blank');
                    }
                    n.close();
                } catch (_) {}
            };
        } catch (e) {
            // Fallback if notifications fail for any reason
            if (typeof window !== 'undefined' && window.DEBUG_DASHBOARD) {
                console.warn('Notification failed, falling back to alert:', e);
            }
            alert(`${title}: ${body}`);
        }
    }

    addPrinter() {
        const name = document.getElementById('printerName').value.trim();
        const ip = document.getElementById('printerIP').value.trim();
        const webcamUrl = document.getElementById('webcamUrl').value.trim();

        if (!name || !ip) {
            alert('Please fill in printer name and IP address');
            return;
        }

        const newPrinter = {
            id: Date.now(),
            name: name,
            ip: ip.startsWith('http') ? ip : `http://${ip}`,
            webcamUrl: webcamUrl || null,
            disabled: false
        };

        this.printers.push(newPrinter);
        this.savePrinters();
        this.renderPrinters();
        
        // Reset form and close modal
        document.getElementById('addPrinterForm').reset();
        document.getElementById('addPrinterModal').style.display = 'none';
    }

    removePrinter(id) {
        if (confirm('Are you sure you want to remove this printer?')) {
            this.printers = this.printers.filter(printer => printer.id !== id);
            this.savePrinters();
            this.renderPrinters();
        }
    }

    saveSettings() {
        const newInterval = parseInt(document.getElementById('pollInterval').value);
        if (newInterval && newInterval > 0) {
            this.pollInterval = newInterval;
            localStorage.setItem('pollInterval', this.pollInterval.toString());
            this.restartWebSocketConnections();
            alert('Settings saved successfully!');
        }
    }

    savePrinters() {
        localStorage.setItem('printers', JSON.stringify(this.printers));
    }

    togglePrinterDisabled(id) {
        const idx = this.printers.findIndex(p => p.id === id);
        if (idx === -1) return;
        const wasDisabled = !!this.printers[idx].disabled;
        this.printers[idx].disabled = !wasDisabled;
        this.savePrinters();
        
        // Handle WebSocket connection for toggled printer
        if (this.printers[idx].disabled) {
            // Disconnect WebSocket if printer is being disabled
            const ws = this.websockets.get(id);
            if (ws) {
                ws.close();
            }
            // Clear reconnection timer
            const timer = this.reconnectTimers.get(id);
            if (timer) {
                clearTimeout(timer);
                this.reconnectTimers.delete(id);
            }
        } else {
            // Connect WebSocket if printer is being enabled
            this.connectWebSocket(this.printers[idx]);
        }
        
        // Re-render the card UI and refresh statuses
        this.renderPrinters();
    }

    renderPrinters() {
        const grid = document.getElementById('printerGrid');
        grid.innerHTML = '';

        this.printers.forEach(printer => {
            const card = this.createPrinterCard(printer);
            grid.appendChild(card);
        });

        // Fetch initial status for all printers
        this.updateAllPrinterStatus();
    }

    createPrinterCard(printer) {
        const card = document.createElement('div');
        card.className = 'printer-card';
        card.innerHTML = `
            <button class="remove-printer" onclick="dashboard.removePrinter(${printer.id})" title="Remove Printer">×</button>
            <button class="disable-printer" onclick="dashboard.togglePrinterDisabled(${printer.id})" title="${printer.disabled ? 'Enable' : 'Disable'} Printer">${printer.disabled ? '⏻' : '⏸'}</button>
            <div class="printer-header">
                <div class="printer-name">${printer.name} <span class="printer-ip">(${printer.ip.replace(/^https?:\/\//, '')})</span></div>
                <div class="printer-status">
                    <span class="status-indicator ${printer.disabled ? 'status-disabled' : 'status-offline'}" id="status-${printer.id}"></span>
                    <span id="status-text-${printer.id}">${printer.disabled ? 'Disabled' : 'Offline'}</span>
                </div>
            </div>
            <div class="printer-info">
                <div class="info-item">
                    <div class="info-label">Current File</div>
                    <div class="info-value" id="file-${printer.id}">-</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Progress</div>
                    <div class="info-value" id="progress-${printer.id}">-</div>
                    <div class="progress-bar">
                        <div class="progress-fill" id="progress-bar-${printer.id}" style="width: 0%"></div>
                    </div>
                </div>
                <div class="info-item">
                    <div class="info-label">Bed Temperature</div>
                    <div class="info-value" id="bed-temp-${printer.id}">-</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Extruder Temperature</div>
                    <div class="info-value" id="extruder-temp-${printer.id}">-</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Print Time</div>
                    <div class="info-value" id="print-time-${printer.id}">-</div>
                </div>
                <div class="info-item">
                    <div class="info-label">ETA</div>
                    <div class="info-value" id="eta-${printer.id}">-</div>
                </div>
            </div>
            ${printer.webcamUrl ? `
                <div class="webcam-container">
                    <img class="webcam-stream" src="${printer.webcamUrl}" alt="Webcam feed" 
                         onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                    <div class="webcam-error" style="display: none;">
                        Webcam unavailable
                    </div>
                </div>
            ` : ''}
        `;
        if (printer.disabled) {
            card.classList.add('disabled');
        }
        return card;
    }

    connectWebSocket(printer) {
        if (printer.disabled) {
            return;
        }

        const host = this.getHostFromIp(printer.ip);
        const wsUrl = `ws://${host}:7125/websocket`;
        
        try {
            const ws = new WebSocket(wsUrl);
            
            ws.onopen = () => {
                console.log(`WebSocket connected to ${printer.name}`);
                
                // Subscribe to printer objects
                const subscribeMessage = {
                    jsonrpc: '2.0',
                    method: 'printer.objects.subscribe',
                    params: {
                        objects: {
                            print_stats: null,
                            heater_bed: null,
                            extruder: null,
                            display_status: null,
                            virtual_sdcard: null,
                        }
                    },
                    id: Date.now()
                };
                
                ws.send(JSON.stringify(subscribeMessage));
                
                // Clear any existing reconnect timer
                const reconnectTimer = this.reconnectTimers.get(printer.id);
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                    this.reconnectTimers.delete(printer.id);
                }
            };
            
            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    
                    // Handle subscription updates
                    if (data.method === 'notify_status_update' && data.params) {
                        this.handleStatusUpdate(printer, data.params[0]);
                    }
                } catch (error) {
                    console.error(`Error parsing WebSocket message for ${printer.name}:`, error);
                }
            };
            
            ws.onclose = () => {
                console.log(`WebSocket disconnected from ${printer.name}`);
                this.websockets.delete(printer.id);
                this.updatePrinterOfflineStatus(printer);
                
                // Schedule reconnection if printer is not disabled
                if (!printer.disabled) {
                    this.scheduleReconnect(printer);
                }
            };
            
            ws.onerror = (error) => {
                console.error(`WebSocket error for ${printer.name}:`, error);
                this.updatePrinterOfflineStatus(printer);
            };
            
            this.websockets.set(printer.id, ws);
            
        } catch (error) {
            console.error(`Failed to create WebSocket for ${printer.name}:`, error);
            this.updatePrinterOfflineStatus(printer);
            this.scheduleReconnect(printer);
        }
    }

    scheduleReconnect(printer) {
        // Clear existing timer
        const existingTimer = this.reconnectTimers.get(printer.id);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        
        // Schedule reconnection in 5 seconds
        const timer = setTimeout(() => {
            if (!printer.disabled) {
                this.connectWebSocket(printer);
            }
            this.reconnectTimers.delete(printer.id);
        }, 5000);
        
        this.reconnectTimers.set(printer.id, timer);
    }

    handleStatusUpdate(printer, statusData) {
        // Update status based on received data
        let currentState = 'idle';

        const printStats = statusData.print_stats;
        const displayStatus = statusData.display_status;
        const virtualSdcard = statusData.virtual_sdcard;
        const heaterBed = statusData.heater_bed;
        const extruder = statusData.extruder;
        
        if (printStats) {
            currentState = printStats.state || 'idle';
            
            // Use virtual_sdcard.progress for more accurate progress calculation
            if (virtualSdcard && virtualSdcard.progress !== undefined) {
                const progress = virtualSdcard.progress;
              document.getElementById(`progress-${printer.id}`).textContent =
                `${Math.round(progress * 100)}%`;
              document.getElementById(`progress-bar-${printer.id}`).style.width =
                `${progress * 100}%`;
              if (printStats.total_duration && progress > 0) {
                const remaining = printStats.total_duration * (1 - progress);
                const eta = new Date(Date.now() + remaining * 1000);
                document.getElementById(`eta-${printer.id}`).textContent =
                  eta.toLocaleTimeString();
              } else {
                document.getElementById(`eta-${printer.id}`).textContent = '-';
              }
            }
            
            // Update print information
            document.getElementById(`file-${printer.id}`).textContent = 
                printStats.filename || '-';

            
            if (printStats.print_duration) {
                const printTime = this.formatTime(printStats.print_duration);
                document.getElementById(`print-time-${printer.id}`).textContent = printTime;
            }
            

        }
        
        // Update temperatures
        if (heaterBed) {
            document.getElementById(`bed-temp-${printer.id}`).textContent = 
                `${Math.round(heaterBed.temperature)}°C / ${Math.round(heaterBed.target)}°C`;
        }
        
        if (extruder) {
            document.getElementById(`extruder-temp-${printer.id}`).textContent = 
                `${Math.round(extruder.temperature)}°C / ${Math.round(extruder.target)}°C`;
        }
        
        // Update status indicator and text
        const statusIndicator = document.getElementById(`status-${printer.id}`);
        const statusText = document.getElementById(`status-text-${printer.id}`);
        
        if (statusIndicator && statusText) {
            switch (currentState) {
                case 'printing':
                    statusIndicator.className = 'status-indicator status-printing';
                    statusText.textContent = 'Printing';
                    break;
                case 'complete':
                    statusIndicator.className = 'status-indicator status-complete';
                    statusText.textContent = 'Complete';
                    this.checkForPrintCompletion(printer, currentState);
                    break;
                case 'paused':
                    statusIndicator.className = 'status-indicator status-printing';
                    statusText.textContent = 'Paused';
                    break;
                default:
                    statusIndicator.className = 'status-indicator status-online';
                    statusText.textContent = 'Ready';
            }
        }
    }

    updatePrinterOfflineStatus(printer) {
        const statusIndicator = document.getElementById(`status-${printer.id}`);
        const statusText = document.getElementById(`status-text-${printer.id}`);
        
        if (statusIndicator && statusText) {
            if (printer.disabled) {
                statusIndicator.className = 'status-indicator status-disabled';
                statusText.textContent = 'Disabled';
            } else {
                statusIndicator.className = 'status-indicator status-offline';
                statusText.textContent = 'Offline';
            }
            this.clearPrinterInfo(printer.id);
        }
    }

    async fetchPrinterStatus(printer) {
        // This method is kept for initial status fetch if needed
        // WebSocket subscriptions will handle real-time updates
        return { online: false };
    }

    getHostFromIp(ip) {
        try {
            const clean = String(ip).replace(/^https?:\/\//, '');
            const [host] = clean.split(':');
            return host || clean;
        } catch (_) {
            return String(ip);
        }
    }

    getMoonrakerProxyEndpoint(printerIp) {
        // Derive host from stored ip (which might include a different port like 4408)
        const host = this.getHostFromIp(printerIp);

        // Use specific mapping if known; otherwise use the generic 7125 proxy
        return `/api/proxy/${host}:7125`;
    }

    async updatePrinterStatus(printer) {
        // For disabled printers, just update the UI status
        if (printer.disabled) {
            this.updatePrinterOfflineStatus(printer);
            const card = document.getElementById(`status-${printer.id}`)?.closest('.printer-card');
            if (card) {
                card.classList.add('disabled');
            }
            return;
        }
        
        // For enabled printers, ensure WebSocket connection exists
        if (!this.websockets.has(printer.id)) {
            this.connectWebSocket(printer);
        }
    }

    checkForPrintCompletion(printer, currentState) {
        const previousState = this.previousStates.get(printer.id);
        
        if (previousState !== 'complete' && currentState === 'complete') {
            this.showCompletionNotification(printer);
        }
        
        this.previousStates.set(printer.id, currentState);
    }

    showCompletionNotification(printer) {
        this.showNotification(
            `Print Complete - ${printer.name}`,
            'Your 3D print has finished!',
            {
                tag: `printer-${printer.id}`,
                requireInteraction: true
            }
        );
    }

    clearPrinterInfo(printerId) {
        const fields = ['file', 'progress', 'bed-temp', 'extruder-temp', 'print-time', 'eta'];
        fields.forEach(field => {
            const element = document.getElementById(`${field}-${printerId}`);
            if (element) element.textContent = '-';
        });
        
        const progressBar = document.getElementById(`progress-bar-${printerId}`);
        if (progressBar) progressBar.style.width = '0%';
    }

    formatTime(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const remainingSeconds = Math.floor(seconds % 60);
        
        if (hours > 0) {
            return `${hours}h ${minutes}m ${remainingSeconds}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${remainingSeconds}s`;
        } else {
            return `${remainingSeconds}s`;
        }
    }

    async updateAllPrinterStatus() {
        // Connect WebSockets for all enabled printers
        this.printers.forEach(printer => {
            this.updatePrinterStatus(printer);
        });
    }

    startWebSocketConnections() {
        this.stopWebSocketConnections();
        this.updateAllPrinterStatus();
    }

    stopWebSocketConnections() {
        // Close all WebSocket connections
        this.websockets.forEach((ws, printerId) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        });
        this.websockets.clear();
        
        // Clear all reconnection timers
        this.reconnectTimers.forEach((timer) => {
            clearTimeout(timer);
        });
        this.reconnectTimers.clear();
    }

    restartWebSocketConnections() {
        this.startWebSocketConnections();
    }
}

// Initialize dashboard when page loads
let dashboard;
document.addEventListener('DOMContentLoaded', () => {
    dashboard = new KlipperDashboard();
});

// Handle page visibility change to pause/resume WebSocket connections
document.addEventListener('visibilitychange', () => {
    if (dashboard) {
        if (document.hidden) {
            dashboard.stopWebSocketConnections();
        } else {
            dashboard.startWebSocketConnections();
        }
    }
});