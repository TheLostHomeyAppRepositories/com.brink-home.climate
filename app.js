'use strict';

const Homey = require('homey');


module.exports = class MyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('MyApp has been initialized');

    //Filter alarm condition card
    this.homey.flow.getConditionCard('alarm_generic').registerRunListener((args, state) => {
      return args.device.getCapabilityValue('alarm_generic');
    });

  }
};


