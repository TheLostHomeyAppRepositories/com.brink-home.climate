'use strict';

const Homey = require('homey');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const URLS = {
  webp:           'https://www.brink-home.com',
  auth:           'https://www.brink-home.com/portal/api/portal/UserLogon',
  systemList:     'https://www.brink-home.com/portal/api/portal/GetSystemList',
  guiDescription: 'https://www.brink-home.com/portal/api/portal/GetAppGuiDescriptionForGateway',
  writeParams:    'https://www.brink-home.com/portal/api/portal/WriteParameterValuesAsync'
};

let cookie = null;
let gatewayId = null;
let systemId = null;
let ventilationId = null;
let modeId = null;
let postModeValue = '0';
let postVentilationValue = '4';
let intervalHandle = null;

module.exports = class MyDevice extends Homey.Device {

  async onInit() {
    this.log('Device initialized');

    const settings = this.getSettings();
    const username = settings.username;
    const password = settings.password;
    const boostTimer = settings.boost_timer * 60000;
    const intervalMs = settings.interval * 60000;

    await this.runMainCycle(username, password);
    this.startInterval(username, password, intervalMs);

    this.registerCapabilityListeners(boostTimer);
    this.registerFlowCards();
  }

  async checkServerHealth(url) {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      return response.ok;
    } catch {
      return false;
    }
  }

  async authenticate(username, password) {
    const response = await fetch(URLS.auth, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      credentials: 'include'
    });

    if (!response.ok) throw new Error('Authentication failed');
    cookie = response.headers.get('Set-Cookie');
  }

  async fetchSystemInfo() {
    const response = await fetch(URLS.systemList, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie },
      credentials: 'include'
    });

    const data = await response.json();
    const deviceId = this.getStoreValue("deviceId");

    if (deviceId) {
      gatewayId = this.getStoreValue("deviceGateway");
      systemId = deviceId;
    } else {
      gatewayId = data[0].gatewayId;
      systemId = data[0].id;
    }
  }

  async fetchGuiDescription() {
    const url = `${URLS.guiDescription}?GatewayId=${gatewayId}&SystemId=${systemId}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cookie': cookie
      },
      credentials: 'include'
    });

    const details = await response.json();
    const parameters = details.menuItems?.[0]?.pages?.[0]?.parameterDescriptors || [];
    const parametersB = details.menuItems?.[0]?.pages?.[1]?.parameterDescriptors || [];

    const ventilation = parameters.find(p => p.uiId === 'Lüftungsstufe');
    const mode = parameters.find(p => p.uiId === 'Betriebsart');
    const filter = parameters.find(p => p.uiId === 'Status Filtermeldung');
    
    const bypassvalue = parametersB.find(p => p.name === 'Status Bypassklappe');

    ventilationId = ventilation.valueId;
    modeId = mode.valueId;
    postVentilationValue = ventilation.value;
    postModeValue = mode.value;

    this.setCapabilityValue('alarm_generic', filter?.value === 1);
    this.setCapabilityValue('operational_state', ventilation.value);
    this.setCapabilityValue('operational_state_2', ventilation.value);
    this.setCapabilityValue('fan_mode', mode.value);
    this.setCapabilityValue('operational_state.fan', mode.value);

    if (this.hasCapability('operational_state.bypass')) {
    this.setCapabilityValue('operational_state.bypass', bypassvalue.value);
    }

    console.log("Fetch details from Brink portal. [Done]");    
  }

  async runMainCycle(username, password) {
    const isOnline = await this.checkServerHealth(URLS.webp);
    if (!isOnline) {
      this.log('Server unreachable, retrying in 1 minute...');
      setTimeout(() => this.runMainCycle(username, password), 60000);
      return;
    }

    try {
      await this.authenticate(username, password);
      await this.fetchSystemInfo();
      await this.fetchGuiDescription();
    } catch (err) {
      this.log('Error in main cycle:', err.message);
    }
  }

  restartInterval(username, password, intervalMs) {
    if (intervalHandle) this.homey.clearInterval(intervalHandle);
    intervalHandle = this.homey.setInterval(() => this.runMainCycle(username, password), intervalMs);
    this.log('Restart.');
  }

  startInterval(username, password, intervalMs) {
    this.restartInterval(username, password, intervalMs);

    this.homey.setInterval(() => {
      this.log('Starting interval...');
      setTimeout(() => this.restartInterval(username, password, intervalMs), 60000);
    }, 3600000);
  }

  registerCapabilityListeners(boostTimer) {
    this.registerMultipleCapabilityListener(['fan_mode'], async ({ fan_mode }) => {
      await this.sendWriteParams([{ ValueId: modeId, Value: fan_mode }]);
      this.setCapabilityValue('fan_mode', fan_mode);
      this.setCapabilityValue('operational_state.fan', fan_mode);
    });

    this.registerMultipleCapabilityListener(['operational_state'], async ({ operational_state }) => {
      const values = operational_state === 4
        ? [{ ValueId: modeId, Value: '0' }]
        : [
            { ValueId: modeId, Value: '1' },
            { ValueId: ventilationId, Value: operational_state }
          ];

      await this.sendWriteParams(values);
      this.setCapabilityValue('operational_state', operational_state);
      this.setCapabilityValue('operational_state_2', operational_state);
    });

    this.registerMultipleCapabilityListener(['button'], async ({ button }) => {
      if (button) {
        await this.sendWriteParams([
          { ValueId: modeId, Value: '1' },
          { ValueId: ventilationId, Value: '3' }
        ]);
        this.setCapabilityValue('operational_state', '3');
        this.setCapabilityValue('operational_state_2', '3');

        this.homey.setTimeout(async () => {
          await this.sendWriteParams([
            { ValueId: modeId, Value: postModeValue },
            { ValueId: ventilationId, Value: postVentilationValue }
          ]);
          this.setCapabilityValue('button', false);
        }, boostTimer);
      } else {
        await this.sendWriteParams([
          { ValueId: modeId, Value: postModeValue },
          { ValueId: ventilationId, Value: postVentilationValue }
        ]);
        this.setCapabilityValue('button', false);
        this.setCapabilityValue('operational_state', postVentilationValue);
        this.setCapabilityValue('operational_state_2', postVentilationValue);
      }
    });
  }

  registerFlowCards() {
    const cardOpState = this.homey.flow.getActionCard('operational_state_flow_card');
    cardOpState.registerRunListener(async (args) => {
      const flowArg = args.operational_state;
      const modeArg = flowArg === '4' ? '0' : '1';

      await this.sendWriteParams([
        { ValueId: modeId, Value: modeArg },
        { ValueId: ventilationId, Value: flowArg }
      ]);

      this.setCapabilityValue('operational_state', flowArg);
      this.setCapabilityValue('operational_state_2', flowArg);
    });

    const cardBoost = this.homey.flow.getActionCard('press');
    cardBoost.registerRunListener(async () => {
      await this.sendWriteParams([
        { ValueId: modeId, Value: '1' },
        { ValueId: ventilationId, Value: '3' }
      ]);
      this.setCapabilityValue('operational_state', '3');
      this.setCapabilityValue('operational_state_2', '3');
    });
  }

  async sendWriteParams(values) {
    await fetch(URLS.writeParams, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie },
      credentials: 'include',
      body: JSON.stringify({
        GatewayId: gatewayId,
        SystemId: systemId,
        WriteParameterValues: values,
        SendInOneBundle: true,
        DependendReadValuesAfterWrite: []
      })
    });
    console.log("POST changes to Brink portal.");
  }

  async onAdded() {
    this.log('Device added');
    const settings = this.getSettings();
    this.restartInterval(settings.username, settings.password, settings.interval * 60000);
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed');
    this.homey.clearInterval(intervalHandle);
    this.onInit();
  }

  async onRenamed(name) {
    this.log('Device renamed');
    const settings = this.getSettings();
    this.restartInterval(settings.username, settings.password, settings.interval * 60000);
  }

  async onDeleted() {
    this.log('Device deleted');
    if (intervalHandle) this.homey.clearInterval;
  }
};
