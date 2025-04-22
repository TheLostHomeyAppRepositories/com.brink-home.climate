'use strict';

const Homey = require('homey');

const fetch = require('node-fetch');

//Declare global variables
let url1 = 'https://www.brink-home.com/portal/api/portal/UserLogon'; // URL for authentication
let url2 = 'https://www.brink-home.com/portal/api/portal/GetSystemList'; // URL to fetch JSON data gateway_id and system_id
let url3 = 'https://www.brink-home.com/portal/api/portal/GetAppGuiDescriptionForGateway'; // URL to fetch details and parameters of climate system
let url4 = 'https://www.brink-home.com/portal/api/portal/WriteParameterValuesAsync'; // URL to POST details and parameters of climate system
let vargatewayId = null;
let varsystemId = null;
let cookie = null;

let ventilationId = null;
let modeId = null;

let preModeValue = null;
let preVentilationValue = null;
let postModeValue = '0';
let postVentilationValue = '4';

let valinterval = 2000;
let globalInterval = null;

module.exports = class MyDevice extends Homey.Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Device has been initialized JvB');

    /** Go get user and password */
    const settings = this.getSettings();

    // Define credentials and settings
    const username = settings.username;
    const password = settings.password;
    const boost_timer = (settings.boost_timer * 60000);
    globalInterval = (settings.interval * 60000);
    
    // Run once before setInterval (loop)
    console.log('### Run once; and later run at interval defined in user settings');

              // Step 1: Authenticate with URL 1 (send POST request with username and password)
              const preauthResponse = await fetch(url1, {
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

            // Check if authentication is successful
            if (!preauthResponse.ok) {
                console.log('Authentication failed');
                return true;
            }

            console.log('Authentication successful');
            cookie = preauthResponse.headers.get('Set-Cookie');

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
                console.log('Fetched data:', predata);

                // Using map() to transform the result array
                const premappedResult = predata.map(system => {
                
                  //const gatewayId = system.gatewayId;
                  vargatewayId = system.gatewayId;  // Push gatewayId outside map function 
                
                  //const systemId = system.id;
                  varsystemId = system.id;  // Push systemId outside map function 
                });
              
                console.log('Gateway ID:', vargatewayId); // Echo the gateway_id to the console log
                console.log('System ID:', varsystemId); // Echo the system_id to the console log

                        // Step 3: Use the session cookie from the first response to make the third API call
                        const url3plusID = `${url3}?GatewayId=${vargatewayId}&SystemId=${varsystemId}`;
                        console.log('Url3 parsed:', url3plusID);
                        
                        const predetailResponse = await fetch(url3plusID, {
                          method: 'GET',
                          headers: {
                              'Content-Type': 'application/json; charset=UTF-8',
                              'Accept-Encoding': 'gzip, deflate, br',
                              'Cookie': cookie // Include the cookie in the headers
                              },
                          credentials: 'include', // Ensure cookies (session cookie) are sent with the request
                        });

                        // Check if data fetch was successful
                        if (!predetailResponse.ok) {
                            console.log('Failed to fetch data from URL 3');
                            return true;
                        }

                        // Parse and log the JSON response from URL 3
                        const details = await predetailResponse.json();
                        console.log('Fetched data:', details);

                        // Extract and map the required values
                        const menuItems = details.menuItems || [];
                        const menuItem = menuItems[0] || {};
                        const pages = menuItem.pages || [];
                        const homePage = pages[0] || {};
                        const parameters = homePage.parameterDescriptors || [];
                        
                        const ventilation = parameters.find(param => param.uiId === 'Lüftungsstufe');
                        const mode = parameters.find(param => param.uiId === 'Betriebsart');
                        const filtersNeedChange = parameters.find(param => param.uiId === 'Status Filtermeldung');

                        const descriptionResult = {
                          ventilation: ventilation ? ventilation.value : null,
                          mode: mode ? mode.value : null,
                          filtersNeedChange: filtersNeedChange ? filtersNeedChange.value : null
                        };

                        ventilationId = ventilation.valueId;
                        modeId = mode.valueId;
                        preVentilationValue = ventilation.value;
                        preModeValue = mode.value;
                        console.log('ventilationId: ' + ventilationId + ', modeId: ' + modeId);

                        // Set device values for Filter, ventilation state and ventilation mode
                        if (filtersNeedChange.value == 1) {
                          this.setCapabilityValue('alarm_generic', true);
                        } else {
                          this.setCapabilityValue('alarm_generic', false);
                        };
                        
                        //Force update sensor values
                        this.setCapabilityValue('operational_state', ventilation.value); //Drop-down menu
                        this.setCapabilityValue('operational_state_2', ventilation.value); //GUI Sensor
                        this.setCapabilityValue('operational_state.fan', mode.value); //Drop-down menu
                        this.setCapabilityValue('fan_mode', mode.value); //GUI Sensor
                        

                        console.log('getDescriptionValues result:', descriptionResult);

                      

                        //Better error handling for fetching data from external webservers
                        console.error = function () {
                          // Suppress error logs
                        };

    /** Collect from Brink-Home Device-ID from API-call */
    // Run on interval; keep going...
    console.log('Start loop at interval = ' + globalInterval);
    const myInterval = this.homey.setInterval(async () => {
            
    console.log('### Here we go again...');
              //Check if webserver is responding; otherwise wait for next interval
              try {
                    const webresponse = await fetch(url1, { method: 'HEAD' }); // HEAD method minimizes data transfer
                    //return webresponse.ok; // Returns true if status code is 200-299
              } catch (error) {
                    console.log("Server is offline or unreachable:");
                    return true;
              }    

              // Step 1: Authenticate with URL 1 (send POST request with username and password)
              const authResponse = await fetch(url1, {
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
            
            
              // Check if authentication is successful
              if (!authResponse.ok) {
                  console.log('Authentication failed, invalid credentials');
                  this.homey.clearInterval(myInterval);
                  return true;
              }

              console.log('Authentication successful');
              cookie = authResponse.headers.get('Set-Cookie');

                  // Step 2: Use the session cookie from the previous response to make the second API call
                  const dataResponse = await fetch(url2, {
                      method: 'GET',
                      headers: {
                          'Content-Type': 'application/json',
                          'Cookie': cookie // Include the cookie in the headers
                      },
                      credentials: 'include', // Ensure cookies (session cookie) are sent with the request
                  });

                  // Check if data fetch was successful
                  if (!dataResponse.ok) {
                      console.log('Failed to fetch data from URL 2');
                      return true;
                  }

             

                  // Parse and log the JSON response from URL 2
                  const data = await dataResponse.json();
                  console.log('Fetched data:', data);

                  // Using map() to transform the result array
                  const mappedResult = data.map(system => {
                  
                    //const gatewayId = system.gatewayId;
                    vargatewayId = system.gatewayId;  // Push gatewayId outside map function 
                  
                    //const systemId = system.id;
                    varsystemId = system.id;  // Push systemId outside map function 
                  });
                
                  console.log('Gateway ID:', vargatewayId); // Echo the gateway_id to the console log
                  console.log('System ID:', varsystemId); // Echo the system_id to the console log

                          // Step 3: Use the session cookie from the first response to make the third API call
                          const url3plusID = `${url3}?GatewayId=${vargatewayId}&SystemId=${varsystemId}`;
                          console.log('Url3 parsed:', url3plusID);
                          
                          const detailResponse = await fetch(url3plusID, {
                            method: 'GET',
                            headers: {
                                'Content-Type': 'application/json; charset=UTF-8',
                                'Accept-Encoding': 'gzip, deflate, br',
                                'Cookie': cookie // Include the cookie in the headers
                                },
                            credentials: 'include', // Ensure cookies (session cookie) are sent with the request
                          });

                          // Check if data fetch was successful
                          if (!detailResponse.ok) {
                              console.log('Failed to fetch data from URL 3');
                              return true;
                          }


                          // Parse and log the JSON response from URL 3
                          const details = await detailResponse.json();
                          console.log('Fetched data:', details);

                          // Extract and map the required values
                          const menuItems = details.menuItems || [];
                          const menuItem = menuItems[0] || {};
                          const pages = menuItem.pages || [];
                          const homePage = pages[0] || {};
                          const parameters = homePage.parameterDescriptors || [];
                          
                          const ventilation = parameters.find(param => param.uiId === 'Lüftungsstufe');
                          const mode = parameters.find(param => param.uiId === 'Betriebsart');
                          const filtersNeedChange = parameters.find(param => param.uiId === 'Status Filtermeldung');

                          const descriptionResult = {
                            ventilation: ventilation ? ventilation.value : null,
                            mode: mode ? mode.value : null,
                            filtersNeedChange: filtersNeedChange ? filtersNeedChange.value : null
                          };

                          ventilationId = ventilation.valueId;
                          modeId = mode.valueId;
                          console.log('ventilationId: ' + ventilationId + ', modeId: ' + modeId);

                          // Set device values for Filter, ventilation state and ventilation mode
                          if (filtersNeedChange.value == 1) {
                            this.setCapabilityValue('alarm_generic', true);
                          } else {
                            this.setCapabilityValue('alarm_generic', false);
                          };
                          
                          //Force update sensor values
                          this.setCapabilityValue('operational_state', ventilation.value);  //Drop-down menu
                          this.setCapabilityValue('operational_state_2', ventilation.value); //Sensor GUI
                          this.setCapabilityValue('operational_state.fan', mode.value); //Drop-down menu
                          this.setCapabilityValue('fan_mode', mode.value); //Sensor GUI
                          

                          console.log('getDescriptionValues result:', descriptionResult);

                          //next run is on defined interval found under settings
                          //valinterval = globalInterval;

                          //return descriptionResult;
                          return true;

    }, globalInterval) 

        // #######################################
        // Submit new values when operation mode AND/OR Fan speed is changed in GUI

        this.registerMultipleCapabilityListener(['fan_mode'], async ({ fan_mode }) => {

          const dataResponse = await fetch(url4, {
            method: "POST",
            headers: {
              'Content-Type': 'application/json',
              'Cookie': cookie // Include the cookie in the headers
              },
            credentials: 'include', // Ensure cookies (session cookie) are sent with the request
              body: JSON.stringify({ 
                  GatewayId: vargatewayId,
                  SystemId: varsystemId,
                  WriteParameterValues: [
                  {
                      ValueId: modeId,
                      Value: fan_mode,
                  },
              ],
              SendInOneBundle: true,
              DependendReadValuesAfterWrite: [] })
              });

          console.log('**** FAN value changed to ',fan_mode);
          this.setCapabilityValue('operational_state.fan', fan_mode);
          this.setCapabilityValue('fan_mode', fan_mode);
        });

        this.registerMultipleCapabilityListener(['operational_state'], async ({ operational_state }) => {
          
        if (operational_state == 4) {

          const dataResponse = await fetch(url4, {
            method: "POST",
            headers: {
              'Content-Type': 'application/json',
              'Cookie': cookie // Include the cookie in the headers
              },
            credentials: 'include', // Ensure cookies (session cookie) are sent with the request
              body: JSON.stringify({ 
                  GatewayId: vargatewayId,
                  SystemId: varsystemId,
                  WriteParameterValues: [
                  {
                      ValueId: modeId,
                      Value: '0',
                  },
              ],
              SendInOneBundle: true,
              DependendReadValuesAfterWrite: [] })
              });
          
          this.setCapabilityValue('operational_state', operational_state);
          this.setCapabilityValue('operational_state_2', operational_state);
          
          console.log('****Operational State changed to ',operational_state);
        } else {
          
          const dataResponse = await fetch(url4, {
            method: "POST",
            headers: {
              'Content-Type': 'application/json',
              'Cookie': cookie // Include the cookie in the headers
              },
            credentials: 'include', // Ensure cookies (session cookie) are sent with the request
              body: JSON.stringify({ 
                  GatewayId: vargatewayId,
                  SystemId: varsystemId,
                  WriteParameterValues: [
                  {
                      ValueId: modeId,
                      Value: '1',
                  },
                  {
                    ValueId: ventilationId,
                    Value: operational_state,
                },
              ],
              SendInOneBundle: true,
              DependendReadValuesAfterWrite: [] })
              });
          
          this.setCapabilityValue('operational_state', operational_state);
          this.setCapabilityValue('operational_state_2', operational_state);
          console.log('****Operational State changed to ',operational_state);
        }
        });
      
    this.registerMultipleCapabilityListener(['button'], async ({ button }) => {
    console.log('****Button pressed value = ',button);

    // #######################################  
    // BOOST TIMER ON: SET new values: Use the session cookie from the previous response to post new values to API
      if (button == true) {
        
        //Store the before values
        postModeValue = mode.value;
        postVentilationValue = ventilation.value;

        const dataResponse = await fetch(url4, {
          method: "POST",
          headers: {
            'Content-Type': 'application/json',
            'Cookie': cookie // Include the cookie in the headers
            },
          credentials: 'include', // Ensure cookies (session cookie) are sent with the request
            body: JSON.stringify({ 
                GatewayId: vargatewayId,
                SystemId: varsystemId,
                WriteParameterValues: [
                {
                    ValueId: modeId,
                    Value: '1',
                },
                {
                  ValueId: ventilationId,
                  Value: '3',
              },
            ],
            SendInOneBundle: true,
            DependendReadValuesAfterWrite: [] })
            });

              // Check if data fetch was successful
              if (!dataResponse.ok) {
                  console.log(dataResponse);
                  return;
              }
              console.log('***Keep boost up for x seconds...');
              this.setCapabilityValue('operational_state', '3');
              this.setCapabilityValue('operational_state_2', '3');
        
              this.homey.setTimeout(async () => {
                console.log("***Switch off Boost after interval");
                this.setCapabilityValue('button', false);

                const dataResponse = await fetch(url4, {
                  method: "POST",
                  headers: {
                    'Content-Type': 'application/json',
                    'Cookie': cookie // Include the cookie in the headers
                    },
                  credentials: 'include', // Ensure cookies (session cookie) are sent with the request
                    body: JSON.stringify({ 
                        GatewayId: vargatewayId,
                        SystemId: varsystemId,
                        WriteParameterValues: [
                        {
                            ValueId: modeId,
                            Value: postModeValue,
                        },
                        {
                          ValueId: ventilationId,
                          Value: postVentilationValue,
                      },
                    ],
                    SendInOneBundle: true,
                    DependendReadValuesAfterWrite: [] })
                    });
              
              }, boost_timer); // 10,000 milliseconds = 10 seconds             
      }

      // #######################################
      // BOOST TIMER OFF: SET new values: Use the session cookie from the previous response to post new values to API
      if (button == false) {
      
        const dataResponse = await fetch(url4, {
          method: "POST",
          headers: {
            'Content-Type': 'application/json',
            'Cookie': cookie // Include the cookie in the headers
            },
          credentials: 'include', // Ensure cookies (session cookie) are sent with the request
            body: JSON.stringify({ 
                GatewayId: vargatewayId,
                SystemId: varsystemId,
                WriteParameterValues: [
                {
                    ValueId: modeId,
                    Value: postModeValue,
                },
                {
                  ValueId: ventilationId,
                  Value: postVentilationValue,
              },
            ],
            SendInOneBundle: true,
            DependendReadValuesAfterWrite: [] })
            });
      
              this.setCapabilityValue('operational_state', postVentilationValue);
              this.setCapabilityValue('operational_state_2', postVentilationValue);

              // Check if data fetch was successful
              if (!dataResponse.ok) {
                  console.log(dataResponse);
                  return;
              }
      }
        });

      // #######################################
      // Flow Action Card for Operational State
      const card_operational_state = this.homey.flow.getActionCard('operational_state_flow_card');
      card_operational_state.registerRunListener(async (args, state) => {

      this.log('flow ops kaart');

      var flow_arg = args.operational_state;
      this.log(flow_arg);
      this.setCapabilityValue('operational_state', flow_arg);
      this.setCapabilityValue('operational_state_2', flow_arg);
      if (flow_arg == '4') { 
        var mode_arg = '0';
      } else {
        var mode_arg = '1';
      };
      this.log('flow_arg = ' + mode_arg);
      const dataResponse = await fetch(url4, {
        method: "POST",
        headers: {
          'Content-Type': 'application/json',
          'Cookie': cookie // Include the cookie in the headers
          },
        credentials: 'include', // Ensure cookies (session cookie) are sent with the request
          body: JSON.stringify({ 
              GatewayId: vargatewayId,
              SystemId: varsystemId,
              WriteParameterValues: [
                  {
                    ValueId: modeId,
                    Value: mode_arg,
                },
                {
                    ValueId: ventilationId,
                    Value: flow_arg,
                },
          ],
          SendInOneBundle: true,
          DependendReadValuesAfterWrite: [] })
          });
  });
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('MyDevice has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('MyDevice settings where changed');
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log('MyDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('MyDevice has been deleted');
  }

}