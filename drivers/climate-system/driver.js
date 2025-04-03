'use strict';

const Homey = require('homey');

module.exports = class MyDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('MyDriver has been initialized');
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  

  async onPair(session) {
    let username = "";
    let password = "";

    session.setHandler("login", async (data) => {
      username = data.username;
      password = data.password;

      const url1 = 'https://www.brink-home.com/portal/api/portal/UserLogon'; // URL for authentication
   
      const credentialsAreValid = await fetch(url1, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            username: username,
            password: password,
        }),
        credentials: 'include', // Store cookies (including session cookie)
    });

      // return true to continue adding the device if the login succeeded
      if (!credentialsAreValid.ok) {
        console.error('Bad account credentials');
        return;
      }
      // return false to indicate to the user the login attempt failed
      // thrown errors will also be shown to the user
      return credentialsAreValid;
    });

    session.setHandler("list_devices", async () => {
      //const api = await DeviceAPI.login({ username, password });
      //const myDevices = await api.getDevices();

      // Example device data, note that `store` is optional
      return [
        {
        name: 'Climate System',
        data: {
          id: 'brink-home-device-' + Date.now(),
        },
        settings: {
          // Store username & password in settings
          // so the user can change them later
          username,
          password,
        },
      },
      ];
    });

  };

  

};
