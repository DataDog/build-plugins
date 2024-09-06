import nock from 'nock';

global.beforeAll(() => {
    // Do not send any HTTP requests.
    nock.disableNetConnect();
});
