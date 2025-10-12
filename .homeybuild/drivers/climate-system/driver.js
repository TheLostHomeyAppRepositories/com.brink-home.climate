'use strict';

const Homey = require('homey');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

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
    let cookie = null;
    let vargatewayId = null;
    let varsystemId = null;
    let varsystemName = null;

    session.setHandler("login", async (data) => {
      username = data.username;
      password = data.password;

      const url1 = 'https://www.brink-home.com/portal/api/portal/UserLogon'; // URL for authentication
      const url2 = 'https://www.brink-home.com/portal/api/portal/GetSystemList'; 

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

    cookie = credentialsAreValid.headers.get('Set-Cookie');

    // return true to continue adding the device if the login succeeded
    if (!credentialsAreValid.ok) {
      console.error('Bad account credentials');
      return;
    }
    // return false to indicate to the user the login attempt failed
    // thrown errors will also be shown to the user
    return credentialsAreValid;

                // Step 2: Use the session cookie from the previous response to make the second API call
                const predataResponse = await fetch(url2, {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                        'Cookie': cookie // Include the cookie in the headers
                    },
                    credentials: 'include', // Ensure cookies (session cookie) are sent with the request
                });

                // Check if data fetch was successful
                if (!predataResponse.ok) {
                    console.log('Failed to fetch data from URL 2');
                    return true;
                }

                // Parse and log the JSON response from URL 2
                const predata = await predataResponse.json();

                // Using map() to transform the result array
                const premappedResult = predata.map(system => {
                
                  varsystemName = system.name;
                  vargatewayId = system.gatewayId;
                  varsystemId = system.id;
                });
                // Count the number of elements in the array
                const count = predata.length;

      // return true to continue adding the device if the login succeeded
      if (!credentialsAreValid.ok) {
        console.error('Bad account credentials');
        return;
      }
      // return false to indicate to the user the login attempt failed
      // thrown errors will also be shown to the user
      return credentialsAreValid;
      const passDATA = predata;
    });

    session.setHandler("list_devices", async () => {
      //const api = await DeviceAPI.login({ username, password });
      //const myDevices = await api.getDevices();
      const randomNumber = Math.floor(10000 + Math.random() * 90000);

      const url1 = 'https://www.brink-home.com/portal/api/portal/UserLogon'; // URL for authentication
      const url2 = 'https://www.brink-home.com/portal/api/portal/GetSystemList'; 

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





    cookie = credentialsAreValid.headers.get('Set-Cookie');
      
      // Step 2: Use the session cookie from the previous response to make the second API call
      const predataResponse = await fetch(url2, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': cookie // Include the cookie in the headers
        },
        credentials: 'include', // Ensure cookies (session cookie) are sent with the request
    });

    // Check if data fetch was successful
    if (!predataResponse.ok) {
        console.log('Invalid credentials');
        return false;
    }

    // Parse and log the JSON response from URL 2
    const predata = await predataResponse.json();

    // Count the number of elements in the array
    const count = predata.length;
    console.log("Number of elements in the array:", count);

      return predata.map(system => ({
        name: system.name,
        data: {
            id: 'brink-home-device-' + system.id + Math.floor(10000 + Math.random() * 90000)
        },
        settings: {
            username,
            password,
        },
        store: {
            deviceId: system.id,
            deviceGateway: system.gatewayId
        }
    }));








    });

  };

  

};
