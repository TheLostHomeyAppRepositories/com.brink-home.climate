'use strict';

const Homey = require('homey');

module.exports = class MyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('MyApp has been initialized');
  
  const card_button = this.homey.flow.getActionCard('press');
  card_button.registerRunListener(async () => {

    this.log('flow button');

  });
  
  
  
  
  
  }
  
};


