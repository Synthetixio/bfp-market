import '@typechain/hardhat';
import '@nomiclabs/hardhat-ethers';
import 'hardhat-contract-sizer';
import 'hardhat-cannon';

const config = {
  defaultNetwork: 'cannon',
  solidity: {
    version: '0.8.19',
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    local: {
      url: '127.0.0.1:8545',
      gas: 12_000_000, // Prevent gas estimation for better error results in tests
    },
    hardhat: {
      gas: 12_000_000, // Prevent gas estimation for better error results in tests
    },
  },
  warnings: {
    'contracts/mocks/**/*': {
      default: 'off',
    },
  },
  cannon: {
    publicSourceCode: false, // Should publish contract sources along with bytecode?
  },
  mocha: {
    timeout: 10 * 1000, // 10s
  },
};

export default config;
