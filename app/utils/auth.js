import { AWSCognitoCredentials } from 'aws-sdk-react-native-core';
import { FBLoginManager } from 'react-native-facebook-login';
import { GoogleSignin } from 'react-native-google-signin';

FBLoginManager.setLoginBehavior(FBLoginManager.LoginBehaviors.Web); // Only for the loading spinner

const IDENTITY_POOL_ID = 'ap-northeast-1:4e86b831-da7f-47d5-8382-3d800cd28a25';
const REGION = 'ap-northeast-1';
const GOOGLE_SIGNIN_IOS_CLIENT_ID = '469382905985-0ho9t3lc0g6ig7l69du9971vijdgv6fn.apps.googleusercontent.com';
const GOOGLE_SIGNIN_WEBCLIENT_ID = '469382905985-sdi5a3gqtk1ikce7cb2f0u6h9ashculq.apps.googleusercontent.com';
const API_URL = 'https://czhz46p32h.execute-api.ap-northeast-1.amazonaws.com/prod';

let identityId = null;
let currentLoginMethod;
let global_supplyLogin = false;
let global_accessToken = '';
let global_openIdToken = '';

const providers = {
  'graph.facebook.com': 'FacebookProvider',
  'accounts.google.com': 'GoogleProvider',
};

let openIdResolve;
let openIdTokenPromise = new Promise(resolve => {
  openIdResolve = resolve;
});

const fbGetCredential = () => {
  return new Promise(resolve => {
    FBLoginManager.getCredentials((err, data) => {
      if (
        data &&
        typeof data.credentials === 'object' &&
        typeof data.credentials.token === 'string' &&
        data.credentials.token.length > 0
      ) {
        currentLoginMethod = 'graph.facebook.com';
        resolve({
          accessToken: data.credentials.token,
        });
      } else {
        console.log('fbGetCredential fail', data, err);
      }
    });
  });
};

const googleGetCredential = () => {
  return new Promise(resolve => {
    GoogleSignin.hasPlayServices({ autoResolve: true })
      .then(() =>
        GoogleSignin.configure({
          iosClientId: GOOGLE_SIGNIN_IOS_CLIENT_ID,
          webClientId: GOOGLE_SIGNIN_WEBCLIENT_ID,
        })
      )
      .then(() => GoogleSignin.currentUserAsync())
      .then(user => {
        console.log('user', user);

        if (user && user.idToken && user.accessToken) {
          currentLoginMethod = 'accounts.google.com';
          resolve({
            idToken: user.idToken,
            accessToken: user.accessToken,
          });
        } else {
          console.log('user error');
        }
      })
      .catch(err => {
        console.log(err);
      });
  });
};

const getCredentials = () => Promise.race([fbGetCredential(), googleGetCredential()]);

// Should after onLoginInvoked
async function getIdentityId() {
  try {
    await AWSCognitoCredentials.getCredentialsAsync();
    const identity = await AWSCognitoCredentials.getIdentityIDAsync();
    // https://github.com/awslabs/aws-sdk-react-native/search?utf8=%E2%9C%93&q=identityid
    // aws-sdk-react-native return `identity.identityId` for ios, `identity.identityid` for android
    const _identityId = identity.identityId || identity.identityid;

    return _identityId;
  } catch (e) {
    console.log('Error: ', e);
  }
}

function cleanLoginStatus() {
  AWSCognitoCredentials.clearCredentials();
  AWSCognitoCredentials.clear(); // clear keychain

  identityId = null;
  global_supplyLogin = false;
  global_accessToken = '';
  global_openIdToken = '';

  openIdTokenPromise = new Promise(resolve => {
    openIdResolve = resolve;
  });
}

function logout() {
  FBLoginManager.logout(error => {
    if (!error) {
      cleanLoginStatus();
    }
  });

  GoogleSignin.signOut().then(() => {
    cleanLoginStatus();
  });
}

async function getOpenIdToken(token) {
  const payload = {
    IdentityId: identityId,
    Logins: {
      [currentLoginMethod]: token,
    },
  };

  try {
    const rsp = await fetch('https://cognito-identity.ap-northeast-1.amazonaws.com/', {
      method: 'POST',
      headers: new Headers({
        'X-Amz-Target': 'AWSCognitoIdentityService.GetOpenIdToken',
        'Content-Type': 'application/x-amz-json-1.1',
        random: new Date().valueOf(),
        'cache-control': 'no-cache',
      }),
      body: JSON.stringify(payload),
    });

    if (!rsp.ok) {
      // rsp.status === 400, ok: false
      // message: "Invalid login token. Token is expired."
      logout();
    } else {
      const json = await rsp.json();

      openIdResolve(json.Token);

      return json.Token;
    }
  } catch (e) {
    console.log('Error of getOpenIdToken: ', e);
  }
}

async function onLoginInvoked(isLoggingIn, accessToken, idToken) {
  if (isLoggingIn) {
    global_supplyLogin = true;
    global_accessToken = accessToken;
    global_openIdToken = idToken;
    const map = {};

    map[providers[currentLoginMethod]] = idToken || accessToken;
    AWSCognitoCredentials.setLogins(map); // ignored for iOS
    identityId = await getIdentityId();
    const token = await getOpenIdToken(idToken || accessToken);

    return {
      accessToken: global_accessToken,
      openIdToken: token,
    };
  } else {
    global_supplyLogin = false;
    global_accessToken = '';
    global_openIdToken = '';
  }
}

function init() {
  AWSCognitoCredentials.getLogins = () => {
    if (global_supplyLogin) {
      const map = {};

      map[providers[currentLoginMethod]] = global_openIdToken || global_accessToken;

      return map;
    }

    return '';
  };

  AWSCognitoCredentials.initWithOptions({
    region: REGION,
    identity_pool_id: IDENTITY_POOL_ID,
  });

  getCredentials().then(tokens => {
    onLoginInvoked(true, tokens.accessToken, tokens.idToken);
  });
}

function loginFB() {
  return new Promise((resolve, reject) => {
    FBLoginManager.loginWithPermissions(
      ['email', 'user_birthday'],
      async (error, data) => {
        if (!error) {
          const token = data.credentials.token;

          currentLoginMethod = 'graph.facebook.com';
          const result = await onLoginInvoked(true, token);

          resolve(result);
        } else {
          currentLoginMethod = null;
          reject(error);
        }
      });
  });
}

async function loginGoogle() {
  const user = await GoogleSignin.signIn().catch(error => {
    console.log('WRONG SIGNIN', err);
    currentLoginMethod = null;
  });

  if (user) {
    currentLoginMethod = 'accounts.google.com';
    return await onLoginInvoked(true, user.accessToken, user.idToken);
  }

  return;
}

async function refreshToken() {
  const token = await getCredentials();
  const openIdToken = await getOpenIdToken(token.idToken || token.accessToken);

  openIdTokenPromise = Promise.resolve(openIdToken);

  return openIdToken;
}

async function register(passedInToken) {
  const openIdToken = passedInToken || (await openIdTokenPromise);
  const payload = {
    accessToken: global_accessToken,
    openIdToken,
  };

  console.log(payload);

  try {
    const rsp = await fetch(`${API_URL}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const json = await rsp.json();

    if (json.statusCode === 401) {
      const newToken = await refreshToken();

      return await register(newToken);
    }

    console.log(json);

    return json.userData;
  } catch (e) {
    console.log('Error: ', e);
  }
}

export {
  init,
  loginFB,
  loginGoogle,
  logout,
  register,
};
