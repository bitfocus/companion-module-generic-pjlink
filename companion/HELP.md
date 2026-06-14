# PJLink

PJLink is a projector control standard created by the Japan Business Machine and Information System Industries Association ([JBMIA](https://www.jbmia.or.jp/english/index.php)). This module implements most commands and data available for both Class 1 and Class 2 protocols.

---

_Note:_
The authorization 'password' sequence generates a random number uses a control ticket to validate messages. This number resets whenever a connection is started. If you access a projector from two different controllers, this number gets regenerated for nearly every command or query as each connection resets the control ticket. This may appear as if the projector is frequently dropping offline.

---

## **Configuration**

| Setting                        | Description                                                              |
| ------------------------------ | ------------------------------------------------------------------------ |
| Target Host/IP                 | Can be either a DNS host name or IP address                              |
| Password                       | If set up in projector                                                   |
| Polling time                   | Number of seconds between status queries to projector. Default 5 seconds |
| Enable extra debug information | If enabled, shows information exchanged with the projector               |

---

## **Available Commands for PJLink**

| Action       | Description                                                         |
| ------------ | ------------------------------------------------------------------- |
| Power        | Turn projector On/Off                                               |
| AV Mute      | Mute selected Audio and/or VideoProjector                           |
| Freeze       | Freeze, Unfreeze or Toggle current Input                            |
| Select Input | Change input to section, Class 2 will retrieve names from Projector |
| Volume +     | Increase Speaker Volume by 1                                        |
| Volume -     | Decrease Speaker Volume 1                                           |

**Note:**
<br>Class 2 projectors provide actual input names
<br>Class 1 Projectors will create generic names based on the input type:

- 1: RGB (analog)
- 2: Video (analog)
- 3: Digital (SDI, DVI, HDMI)
- 4: Storage (USB, SD Card)
- 5: Network (HD-BaseT, NDI)
- 6: Internal (Flash memory Logo or still)

---

## **Available Variables for PJLink**

| Variable          | Description                                   |
| ----------------- | --------------------------------------------- |
| projectorClass    | Projector Class (1 or 2)                      |
| projectorName     | Projector Name                                |
| projectorMake     | Projector Manufacturer                        |
| projectorModel    | Projector Model                               |
| projectorOther    | Projector Other Info                          |
| errorCover        | Cover Open                                    |
| errorFan          | Fan error                                     |
| errorFilter       | Filter error                                  |
| errorLamp         | Lamp Error                                    |
| errorOther        | Miscellaneous error                           |
| errorTemp         | Temperature error                             |
| freezeState       | Freeze Status                                 |
| inputHorzRes      | Current Input Horizontal Resolution           |
| inputVertRes      | Current Input Vertical Resolution             |
| recHorzRes        | Recommended Horizontal Resolution             |
| recVertRes        | Recommended Vertical Resolution               |
| lamp#Hrs          | Lamp Hours (# = 1 to 8) (N/A for laser units) |
| lamp#On           | Lamp On (# = 1 to 8)                          |
| serialNumber      | Serial Number                                 |
| softwareVersion   | Software Version                              |
| filterUsageTime   | Filter Usage Time                             |
| filterReplacement | Filter Replacement Model Number               |
| lampReplacement   | Lamp Replacement Model Number                 |
| muteState         | Mute Status                                   |
| powerState        | Power Status                                  |
| projectorInput    | Projector Input Description                   |

**Note:** Some variables are only available with Class 2 protocol. These will show as 'N/A' on a Class 1 projector.

---

## **Available Feedback for PJLink**

| Feedback        | Condition                                           |
| --------------- | --------------------------------------------------- |
| Error Status    | Indicate error state                                |
| Freeze Status   | Indicate freeze state                               |
| Lamp Hour       | Indicate if selected lamp hours over certain amount |
| Lamp Status     | Indicate if selected Lamp is On or Off              |
| Mute Status     | Indicate mute state                                 |
| Power Status    | Indicate power state (Off/Warmup/On/Cooling)        |
| Projector Input | Indicate if projector is on selected input          |

---

Contributions for maintenance and development of this open source module are always welcome
<https://github.com/sponsors/istnv>

---
