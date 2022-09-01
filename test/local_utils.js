const { ethers } = require("hardhat");

// TODO: MOVE THIS FUNCTION TO @ensuro/core

/*
Builds the component role identifier

Mimics the behaviour of the PolicyPoolConfig.getComponentRole method

Component roles are roles created doing XOR between the component
address and the original role.

Example: 
    getComponentRole("0xc6e7DF5E7b4f2A278906862b61205850344D4e7d", "ORACLE_ADMIN_ROLE")
    // "0x05e01b185238b49f750d03d945e38a7f6c3be8b54de0ee42d481eb7814f0d3a8"
*/
function getComponentRole(componentAddress, roleName) {
  // 32 byte array
  const bytesRole = ethers.utils.arrayify(ethers.utils.keccak256(ethers.utils.toUtf8Bytes(roleName)));

  // 20 byte array
  const bytesAddress = ethers.utils.arrayify(componentAddress);

  // xor each byte, padding bytesAddress with zeros at the end
  return ethers.utils.hexlify(bytesRole.map((elem, idx) => elem ^ (bytesAddress[idx] || 0)));
}

exports.getComponentRole = getComponentRole;

/*
Builds AccessControl error message for comparison in tests
*/
function accessControlMessage(address, component, role) {
  return `AccessControl: account ${address.toLowerCase()} is missing role ${getComponentRole(component, role)}`;
}

exports.accessControlMessage = accessControlMessage;

function makePolicyId(rm, internalId) {
  return ethers.BigNumber.from(rm.address).shl(96).add(internalId);
}

exports.makePolicyId = makePolicyId;
